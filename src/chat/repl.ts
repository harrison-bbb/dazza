import { homedir } from 'node:os';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import pkg from '../../package.json' with { type: 'json' };
import { startBoard } from '../board/server.js';
import { Config } from '../core/config.js';
import { describeCodebase, inspectCodebase } from '../core/inspect.js';
import { Manager } from '../core/manager.js';
import { Store } from '../core/store.js';
import { McpTools } from '../mcp/server.js';
import { ClaudeProvider } from '../providers/claude.js';
import { openInBrowser } from '../util/open.js';
import { BRAND, banner } from './banner.js';
import { type CommandContext, complete, parseCommand, suggest } from './commands.js';
import { describeTool, greeting, planCard } from './describe.js';
import { Spinner } from './spinner.js';
import { paint, renderInline } from './style.js';

const PROMPT = `${paint.hex(BRAND, '›')} `;

/** `dazza`: the conversation with your developer. */
export async function startChat(projectRoot: string): Promise<void> {
  const provider = new ClaudeProvider();
  const status = await provider.detect();
  if (!status.installed || !status.loggedIn) {
    console.error(
      paint.red('Dazza needs Claude Code installed and signed in. Run `dazza doctor`.'),
    );
    process.exitCode = 1;
    return;
  }

  const store = new Store(projectRoot);
  const config = new Config();
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
  console.log(
    `\n${banner({
      version: pkg.version,
      agent: [provider.name, status.plan, model && `model: ${model}`].filter(Boolean).join(' · '),
      cwd: projectRoot.replace(homedir(), '~'),
      board: board.url,
    })}\n`,
  );
  const hasConversation = (await store.readManagerSession()) !== undefined;
  say(greeting(await store.readPlan(), { hasConversation, ...(codebase && { codebase }) }));

  const rl = createInterface({ input: stdin, output: stdout, prompt: PROMPT, completer: complete });
  let running: AbortController | undefined;
  let exiting = false;
  rl.on('SIGINT', () => (running ? running.abort() : rl.close()));

  const context: CommandContext = {
    store,
    config,
    provider,
    boardUrl: board.url,
    say,
    exit: () => {
      exiting = true;
    },
  };

  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line.startsWith('/')) {
      await runCommand(line, context);
    } else if (line) {
      running = new AbortController();
      await converse(manager, store, board.url, line, running.signal);
      running = undefined;
    }
    if (exiting) break;
    rl.prompt();
  }
  rl.close();
  board.close();
}

async function converse(
  manager: Manager,
  store: Store,
  boardUrl: string,
  message: string,
  signal: AbortSignal,
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
      } else if (event.type === 'finished' && !event.ok) {
        spinner.stop();
        say(paint.red(event.output || 'Something went wrong on my end.'));
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
