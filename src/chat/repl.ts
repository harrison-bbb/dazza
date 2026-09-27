import { homedir } from 'node:os';
import pkg from '../../package.json' with { type: 'json' };
import { startBoard } from '../board/server.js';
import { Config, type Connection } from '../core/config.js';
import { describeCodebase, inspectCodebase } from '../core/inspect.js';
import { Manager } from '../core/manager.js';
import { Store } from '../core/store.js';
import { McpTools } from '../mcp/server.js';
import { ClaudeProvider } from '../providers/claude.js';
import { checkApiKey } from '../setup/anthropic.js';
import { connect } from '../setup/connect.js';
import { openInBrowser } from '../util/open.js';
import { BRAND, logo, sessionInfo } from './banner.js';
import { type CommandContext, commandMenu, parseCommand, suggest, type Usage } from './commands.js';
import { describeTool, greeting, planCard } from './describe.js';
import { Spinner } from './spinner.js';
import { paint, renderInline } from './style.js';
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

  let exiting = false;
  const session: Usage = { runs: 0, tokens: 0, costUsd: 0 };
  const context: CommandContext = {
    store,
    config,
    provider,
    connection,
    session,
    boardUrl: board.url,
    say,
    exit: () => {
      exiting = true;
    },
  };

  const history: string[] = [];
  while (!exiting) {
    const input = await terminal.readLine({ prompt: PROMPT, menu: commandMenu, history });
    if (input === undefined) break;
    const line = input.trim();
    if (line && line !== history.at(-1)) history.push(line);

    if (line.startsWith('/')) {
      await runCommand(line, context);
    } else if (line) {
      const running = new AbortController();
      terminal.interrupt(() => running.abort());
      await converse(manager, store, board.url, line, running.signal, session);
      terminal.interrupt(undefined);
    }
  }
  board.close();
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

async function converse(
  manager: Manager,
  store: Store,
  boardUrl: string,
  message: string,
  signal: AbortSignal,
  session: Usage,
) {
  const before = await store.readPlan();
  const spinner = new Spinner();
  let rewrotePlan = false;
  spinner.start('Thinking');

  try {
    for await (const event of manager.send(message, signal)) {
      if (event.type === 'text') {
        spinner.stop();
        say(renderInline(event.text));
        spinner.start('Thinking');
      } else if (event.type === 'tool_use') {
        rewrotePlan ||= event.tool === McpTools.savePlan;
        spinner.update(describeTool(event.tool, event.input));
      } else if (event.type === 'finished') {
        if (event.usage) {
          session.runs++;
          session.tokens += event.usage.tokens;
          session.costUsd += event.usage.costUsd;
        }
        if (!event.ok) {
          spinner.stop();
          say(paint.red(event.output || 'Something went wrong on my end.'));
        }
      }
    }
  } catch (error) {
    spinner.stop();
    say(signal.aborted ? paint.dim('Stopped.') : paint.red(`Error: ${errorMessage(error)}`));
  } finally {
    spinner.stop();
  }

  // Small edits are confirmed in Dazza's own reply; a rewritten plan gets the full card.
  const after = await store.readPlan();
  if (rewrotePlan && after && JSON.stringify(after) !== JSON.stringify(before)) {
    console.log(`${planCard(after, Boolean(before?.approvedAt), boardUrl)}\n`);
    // The first plan is the moment to show the board; after that the tab is already open.
    if (!before) openInBrowser(boardUrl);
  }
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

/** Print Dazza's words with a little breathing room, indented under a marker. */
function say(text: string): void {
  const [first = '', ...rest] = text.trim().split('\n');
  const body = rest.map((line) => (line.trim() ? `\n  ${line}` : '\n')).join('');
  console.log(`\n${paint.hex(BRAND, '●')} ${first}${body}\n`);
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
