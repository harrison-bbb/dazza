import { homedir } from 'node:os';
import pkg from '../../package.json' with { type: 'json' };
import { startBoard } from '../board/server.js';
import { Config, type Connection } from '../core/config.js';
import { describeCodebase, inspectCodebase } from '../core/inspect.js';
import { Manager } from '../core/manager.js';
import { Store } from '../core/store.js';
import { ClaudeProvider } from '../providers/claude.js';
import { checkApiKey } from '../setup/anthropic.js';
import { connect } from '../setup/connect.js';
import { BRAND, logo, sessionInfo } from './banner.js';
import { type CommandContext, commandMenu, parseCommand, suggest } from './commands.js';
import { greeting } from './describe.js';
import { ChatSession } from './session.js';
import { paint } from './style.js';
import { Terminal } from './terminal.js';

const PROMPT = `${paint.hex(BRAND, '›')} `;

/** `dazza`: the conversation with your developer. */
export async function startChat(projectRoot: string): Promise<void> {
  const terminal = new Terminal();
  try {
    await chat(projectRoot, terminal);
  } finally {
    terminal.close();
  }
}

async function chat(projectRoot: string, terminal: Terminal): Promise<void> {
  write = (text) => terminal.print(text);
  console.log(`\n${logo()}\n`);
  const config = new Config();
  const connection = (await config.readConnection()) ?? (await firstConnect(terminal, config));
  if (!connection) return;

  const provider = new ClaudeProvider({ connection });
  const status = await provider.detect();
  if (!status.installed || (connection.method === 'subscription' && !status.loggedIn)) {
    say(
      paint.red(
        status.installed
          ? 'Your Claude Code sign-in has expired. Run `claude` to sign in, then start Dazza again.'
          : 'Dazza needs Claude Code installed. Run `dazza doctor` for details.',
      ),
    );
    process.exitCode = 1;
    return;
  }

  const store = new Store(projectRoot);
  const found = await inspectCodebase(projectRoot);
  const codebase = found && describeCodebase(found);
  const board = await startBoard(store, projectRoot);
  const manager = new Manager({
    store,
    config,
    provider,
    projectRoot,
    mcpServer: { command: process.execPath, args: [cliPath(), 'mcp', '--root', projectRoot] },
    ...(codebase && { codebase }),
  });

  const { model } = await config.readSettings();
  const plan = connection.method === 'api-key' ? 'API key' : status.plan;
  console.log(
    `${sessionInfo({
      version: pkg.version,
      agent: [provider.name, plan, model && `model: ${model}`].filter(Boolean).join(' · '),
      cwd: projectRoot.replace(homedir(), '~'),
      board: board.url,
    })}`,
  );
  const hasConversation = (await store.readManagerSession()) !== undefined;
  say(greeting(await store.readPlan(), { hasConversation, ...(codebase && { codebase }) }));

  const session = new ChatSession({
    store,
    config,
    provider,
    manager,
    workerMcp: {
      command: process.execPath,
      args: [cliPath(), 'mcp', '--root', projectRoot, '--role', 'worker'],
    },
    boardUrl: board.url,
    output: {
      say,
      print: (text) => terminal.print(text),
      status: (key, text) => terminal.setStatus(key, text),
    },
  });

  let exiting = false;
  const context: CommandContext = {
    store,
    config,
    provider,
    connection,
    session: session.usage,
    boardUrl: board.url,
    startBuild: () => startBuild(session, provider, config),
    status: (text) => terminal.setStatus('chat', text),
    say,
    exit: () => {
      exiting = true;
    },
  };

  const history: string[] = [];
  while (!exiting) {
    const input = await terminal.readLine({ prompt: PROMPT, menu: commandMenu, history });
    if (input === undefined) {
      // Piped input ran out: let queued work finish. In a terminal, Ctrl-C stops
      // whatever is running first, and only exits once nothing is.
      if (!terminal.interactive) await session.idle();
      else if (session.isBuilding) {
        await session.stopBuild();
        continue;
      } else if (session.isChatting) {
        await session.stopChat();
        continue;
      }
      break;
    }
    const line = input.trim();
    if (line && line !== history.at(-1)) history.push(line);

    if (line.startsWith('/')) await runCommand(line, context);
    else if (line) session.send(line);
  }

  await session.stopBuild();
  await session.stopChat();
  board.close();
}

/** /build: check the model can work on its own, then build in the background. */
async function startBuild(
  session: ChatSession,
  provider: ClaudeProvider,
  config: Config,
): Promise<void> {
  if (session.isBuilding) {
    say('Already building. Keep talking to me, or Ctrl-C to stop the build.');
    return;
  }
  const models = await provider.listModels();
  const chosen = (await config.readSettings()).model;
  const model = models.find((m) => m.id === chosen) ?? models[0];
  if (model && !model.autonomous) {
    say(
      `${model.name} can’t build on its own: it doesn’t support Claude Code’s auto mode. ` +
        'Switch to one that does, like Opus or Sonnet, with /model.',
    );
    return;
  }
  session.startBuild();
  say(
    paint.dim(
      'Building in the background. Keep talking to me while I work; Ctrl-C stops the build.',
    ),
  );
}

/** First launch, or after /logout: pick how Dazza connects, and remember it. */
async function firstConnect(terminal: Terminal, config: Config): Promise<Connection | undefined> {
  const claude = new ClaudeProvider();
  const connection = await connect(
    {
      say,
      select: (question, choices) => terminal.select(question, choices),
      readLine: (options) => terminal.readLine(options),
    },
    {
      detectClaude: () => claude.detect(),
      signInToClaude: () => terminal.handOver(() => claude.signIn()),
      checkApiKey,
    },
  );
  if (connection) await config.writeConnection(connection);
  return connection;
}

async function runCommand(line: string, context: CommandContext): Promise<void> {
  const { command, name, args } = parseCommand(line);
  if (!command) {
    const hint = suggest(name);
    say(paint.dim(`No command /${name}.${hint ? ` Did you mean /${hint.name}?` : ''} Try /help.`));
    return;
  }
  try {
    await command.run(context, args);
  } catch (error) {
    say(paint.red(`/${command.name} failed: ${errorMessage(error)}`));
  }
}

/** Where Dazza's words go: the terminal once the chat starts, so they print around the input. */
let write: (text: string) => void = (text) => console.log(text);

/** Print Dazza's words with a little breathing room, indented under a marker. */
function say(text: string): void {
  const [first = '', ...rest] = text.trim().split('\n');
  const body = rest.map((line) => (line.trim() ? `\n  ${line}` : '\n')).join('');
  write(`\n${paint.hex(BRAND, '●')} ${first}${body}\n`);
}

/** Path of the running CLI, so the agent can launch our MCP server with the same build. */
function cliPath(): string {
  const path = process.argv[1];
  if (!path) throw new Error('Cannot determine the dazza executable path');
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
