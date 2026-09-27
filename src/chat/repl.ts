import { homedir } from 'node:os';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import pkg from '../../package.json' with { type: 'json' };
import { Manager } from '../core/manager.js';
import { approve } from '../core/plan.js';
import { Store } from '../core/store.js';
import { McpTools } from '../mcp/server.js';
import { ClaudeProvider } from '../providers/claude.js';
import { BRAND, banner } from './banner.js';
import { describeTool, greeting } from './describe.js';
import { Spinner } from './spinner.js';
import { paint, renderInline } from './style.js';

const PROMPT = `${paint.hex(BRAND, '›')} `;

const HELP = `
  ${paint.bold('Just type')} to talk to Dazza. Commands:
  /status   Where the project is at
  /approve  Approve the drafted plan
  /help     Show this
  /exit     Leave (Ctrl-C works too)
`;

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
  const manager = new Manager({
    store,
    provider,
    projectRoot,
    mcpServer: { command: process.execPath, args: [cliPath(), 'mcp', '--root', projectRoot] },
  });

  console.log(
    `\n${banner({
      version: pkg.version,
      agent: `${provider.name} v${status.version}${status.authMethod ? ` · ${status.authMethod}` : ''}`,
      cwd: projectRoot.replace(homedir(), '~'),
    })}\n`,
  );
  say(greeting(await store.readPlan(), (await store.readManagerSession()) !== undefined));

  const rl = createInterface({ input: stdin, output: stdout, prompt: PROMPT });
  let running: AbortController | undefined;
  rl.on('SIGINT', () => (running ? running.abort() : rl.close()));

  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '/exit') break;
    if (line.startsWith('/')) {
      await runCommand(line, store);
    } else if (line) {
      running = new AbortController();
      await converse(manager, store, line, running.signal);
      running = undefined;
    }
    rl.prompt();
  }
  rl.close();
}

async function converse(manager: Manager, store: Store, message: string, signal: AbortSignal) {
  const spinner = new Spinner();
  let savedPlan = false;
  spinner.start('Thinking');

  try {
    for await (const event of manager.send(message, signal)) {
      if (event.type === 'text') {
        spinner.stop();
        say(renderInline(event.text));
        spinner.start('Thinking');
      } else if (event.type === 'tool_use') {
        savedPlan ||= event.tool === McpTools.savePlan;
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

  const plan = savedPlan ? await store.readPlan() : undefined;
  if (plan) {
    say(`${paint.green('✔')} Plan saved: ${plan.tasks.length} tasks in ${paint.bold('.dazza/')}`);
  }
}

async function runCommand(command: string, store: Store): Promise<void> {
  switch (command) {
    case '/help':
      console.log(HELP);
      return;
    case '/status':
      say(greeting(await store.readPlan()));
      return;
    case '/approve': {
      const plan = await store.readPlan();
      if (!plan) return say('Nothing to approve yet. Tell me what we are building first.');
      if (plan.approvedAt) return say('Already approved.');
      await store.writePlan(approve(plan, new Date()));
      await store.appendEvent({
        at: new Date().toISOString(),
        type: 'plan_approved',
        message: 'Plan approved',
      });
      return say(`${paint.green('✔')} Approved. ${plan.tasks.length} tasks locked in.`);
    }
    default:
      say(paint.dim(`Unknown command ${command}. Try /help.`));
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
