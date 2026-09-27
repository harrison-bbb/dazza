import { approvePlan } from '../core/actions.js';
import type { Config, Limits } from '../core/config.js';
import type { Store } from '../core/store.js';
import type { AgentProvider, ModelOption } from '../providers/types.js';
import { openInBrowser } from '../util/open.js';
import { BRAND } from './banner.js';
import { greeting } from './describe.js';
import { Spinner } from './spinner.js';
import { paint } from './style.js';

/** What a command can reach. Kept small so commands are easy to test. */
export interface CommandContext {
  store: Store;
  config: Config;
  provider: AgentProvider;
  boardUrl: string;
  /** Print Dazza's reply. */
  say(text: string): void;
  /** End the chat after this command. */
  exit(): void;
}

export interface Command {
  name: string;
  aliases?: string[];
  /** Shown after the name in /help, e.g. "[name or number]". */
  args?: string;
  description: string;
  run(context: CommandContext, args: string): Promise<void> | void;
}

export const COMMANDS: Command[] = [
  {
    name: 'dashboard',
    aliases: ['board'],
    description: 'Open the project dashboard in your browser',
    run({ boardUrl, say }) {
      openInBrowser(boardUrl);
      say(`Opened ${paint.hex(BRAND, boardUrl)}`);
    },
  },
  {
    name: 'status',
    description: 'Where the project is at',
    async run({ store, say }) {
      const plan = await store.readPlan();
      say(plan ? greeting(plan) : 'No plan yet. Tell me what you want to build or change.');
    },
  },
  {
    name: 'approve',
    description: 'Approve the drafted plan so Dazza can start',
    async run({ store, say }) {
      const result = await approvePlan(store);
      say(result.ok ? `${paint.green('✔')} ${result.message}` : result.message);
    },
  },
  {
    name: 'model',
    args: '[name or number]',
    description: 'Show the models you can use, or switch model',
    async run({ provider, config, say }, args) {
      const models = await withSpinner('Checking your models', () => provider.listModels());
      const current = (await config.readSettings()).model ?? models[0]?.id;

      if (!args) {
        say(modelList(models, current));
        return;
      }
      const choice = pickModel(models, args);
      if (!choice) {
        say(`No model matches “${args}”. ${paint.dim('Run /model to see your options.')}`);
        return;
      }
      await config.updateSettings({ model: choice.id });
      say(
        `${paint.green('✔')} Switched to ${paint.bold(choice.name)}. Dazza uses it from your next message.`,
      );
    },
  },
  {
    name: 'usage',
    description: 'Your plan limits and what Dazza has used on this project',
    async run({ provider, config, store, say }) {
      const [status, limits, usage] = await Promise.all([
        provider.detect(),
        config.readLimits(),
        store.readUsage(),
      ]);
      const plan = status.installed ? status.plan : undefined;
      say(usageReport(plan ?? provider.name, limits, usage));
    },
  },
  {
    name: 'logout',
    args: '[confirm]',
    description: `Sign out of the coding agent's CLI`,
    async run({ provider, say, exit }, args) {
      if (args !== 'confirm') {
        say(
          `Dazza uses your ${provider.name} sign-in, so this signs you out of ${provider.name} ` +
            `on this machine, not just Dazza.\n${paint.dim('Type /logout confirm to go ahead.')}`,
        );
        return;
      }
      await provider.logout();
      say(
        `Signed out of ${provider.name}. Sign back in by running \`claude\`, then start Dazza again.`,
      );
      exit();
    },
  },
  {
    name: 'help',
    description: 'Show this list',
    run({ say }) {
      say(helpText());
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'Leave (Ctrl-C works too)',
    run({ exit }) {
      exit();
    },
  },
];

/** Split "/model sonnet" into the command and its arguments. */
export function parseCommand(line: string): {
  command: Command | undefined;
  name: string;
  args: string;
} {
  const [head = '', ...rest] = line.slice(1).trim().split(/\s+/);
  const name = head.toLowerCase();
  const command = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  return { command, name, args: rest.join(' ') };
}

/** The closest command to a mistyped one, for "did you mean". */
export function suggest(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name.startsWith(name.slice(0, 2)));
}

/** Tab completion for readline. */
export function complete(line: string): [string[], string] {
  if (!line.startsWith('/') || line.includes(' ')) return [[], line];
  const hits = COMMANDS.map((c) => `/${c.name}`).filter((c) => c.startsWith(line));
  return [hits, line];
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => {
    const usage = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
    return `  ${paint.hex(BRAND, usage.padEnd(26))}${paint.dim(c.description)}`;
  });
  return `Just type to talk to me. Or use a command:\n${rows.join('\n')}`;
}

export function modelList(models: ModelOption[], current: string | undefined): string {
  const width = Math.max(...models.map((m) => m.name.length));
  const rows = models.map((m, i) => {
    const marker = m.id === current ? paint.green('●') : ' ';
    return `${marker} ${paint.dim(String(i + 1).padStart(2))}  ${m.name.padEnd(width)}  ${paint.dim(m.description)}`;
  });
  return `Models you can use:\n${rows.join('\n')}\n${paint.dim('Switch with /model <number or name>, e.g. /model 2')}`;
}

/** Match by list number, id ("sonnet") or display name ("Sonnet 5"). */
export function pickModel(models: ModelOption[], input: string): ModelOption | undefined {
  const query = input.trim().toLowerCase();
  const index = Number(query);
  if (Number.isInteger(index) && index >= 1) return models[index - 1];
  return (
    models.find((m) => m.id.toLowerCase() === query || m.name.toLowerCase() === query) ??
    models.find((m) => m.name.toLowerCase().startsWith(query))
  );
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
};

export function usageReport(
  plan: string,
  limits: Limits | undefined,
  usage: { runs: number; tokens: number; costUsd: number },
  now = new Date(),
): string {
  const lines = [paint.bold(plan)];
  if (limits && limits.windows.length > 0) {
    for (const window of limits.windows) {
      const name = (WINDOW_NAMES[window.id] ?? window.id).padEnd(16);
      const percent = `${Math.round(window.utilization * 100)}%`.padStart(4);
      lines.push(
        `${name}${bar(window.utilization)} ${percent}  ${paint.dim(`resets ${when(window.resetsAt, now)}`)}`,
      );
    }
    lines.push(paint.dim(`As of your last message to Dazza, ${ago(limits.checkedAt, now)}.`));
  } else {
    lines.push(paint.dim('No limit reading yet. It updates every time Dazza replies.'));
  }
  lines.push(
    '',
    `${'This project'.padEnd(16)}${usage.runs} ${usage.runs === 1 ? 'message' : 'messages'} · ` +
      `${compact(usage.tokens)} tokens · ` +
      `$${usage.costUsd.toFixed(2)} at API prices`,
  );
  return lines.join('\n');
}

function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return paint.hex(BRAND, '█'.repeat(filled)) + paint.dim('░'.repeat(width - filled));
}

function when(iso: string, now: Date): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

async function withSpinner<T>(text: string, work: () => Promise<T>): Promise<T> {
  const spinner = new Spinner();
  spinner.start(text);
  try {
    return await work();
  } finally {
    spinner.stop();
  }
}
