import { approvePlan } from '../core/actions.js';
import type { Config, Connection, Limits } from '../core/config.js';
import type { Store } from '../core/store.js';
import type { ChannelId } from '../notify/channel.js';
import { PROVIDER_HELP } from '../providers/index.js';
import type { AgentProvider, ModelOption, ProviderId } from '../providers/types.js';
import { openInBrowser } from '../util/open.js';
import { BRAND } from './banner.js';
import { greeting } from './describe.js';
import type { MenuItem } from './editor.js';
import { paint } from './style.js';

/** What a command can reach. Kept small so commands are easy to test. */
export interface CommandContext {
  store: Store;
  config: Config;
  provider: AgentProvider;
  connection: Connection;
  /** What this chat session has used so far. */
  session: Usage;
  boardUrl: string;
  /** Build the approved plan in the background, showing the work live. */
  startBuild(): Promise<void>;
  /** Show (or clear) an activity in the status line while a command works. */
  status(text: string | undefined): void;
  /** Walk through linking Slack or a Telegram bot. */
  link(channel: ChannelId): Promise<void>;
  /** Forget the Slack app or Telegram bot. */
  unlink(channel: ChannelId): Promise<void>;
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
    name: 'build',
    description: 'Start building the plan, task by task, and watch the work',
    async run({ startBuild }) {
      await startBuild();
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
    async run({ provider, config, say, status }, args) {
      status('Checking your models');
      const models = await provider.listModels().finally(() => status(undefined));
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
    description: 'Plan limits, or API spend if you pay as you go',
    async run({ provider, config, store, connection, session, say, status }) {
      if (connection.method === 'api-key') {
        say(spendReport(provider.id, session, await store.readUsage()));
        return;
      }
      status('Checking your usage');
      try {
        // Codex can read limits live; Claude Code only reports them during a run.
        const [detected, live] = await Promise.all([provider.detect(), provider.readLimits?.()]);
        const limits = live
          ? { checkedAt: new Date().toISOString(), windows: live }
          : await config.readLimits();
        const plan =
          (detected.installed && detected.plan) ||
          `${PROVIDER_HELP[provider.id].brand} subscription`;
        say(limitsReport(plan, limits, { live: Boolean(live) }));
      } finally {
        status(undefined);
      }
    },
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Start a fresh conversation (the plan and board stay as they are)',
    async run({ store, say }) {
      await store.clearManagerSession();
      say('Fresh conversation. The plan and the board are as they were. What’s next?');
    },
  },
  {
    name: 'logout',
    description: 'Sign out of Dazza (your Claude Code or Codex sign-in stays as it is)',
    async run({ config, say, exit }) {
      await config.clearConnection();
      // Models are per agent CLI, and you may reconnect with the other one.
      await config.updateSettings({ model: undefined });
      say('Signed out of Dazza. Run `dazza` again to reconnect with a subscription or an API key.');
      exit();
    },
  },
  {
    name: 'slack',
    description: 'See your Slack link, or connect Slack',
    async run({ config, say, link }) {
      const slack = await config.readSlack();
      if (!slack) return link('slack');
      say(
        `Connected to ${slack.teamName}. I message you there about reviews and blockers, ` +
          'and you can reply, approve work and start builds from Slack.\n' +
          paint.dim('Run /slack-disconnect to link a different workspace.'),
      );
    },
  },
  {
    name: 'slack-disconnect',
    description: 'Unlink Slack, then link it again if you like',
    async run({ config, say, link, unlink }) {
      const slack = await config.readSlack();
      if (slack) {
        await unlink('slack');
        say(
          `Disconnected from ${slack.teamName}. Let’s link it again, or press Ctrl-C to stay unlinked. ` +
            paint.dim('To remove the app itself, delete it at https://api.slack.com/apps.'),
        );
      }
      await link('slack');
    },
  },
  {
    name: 'telegram',
    description: 'See your Telegram link, or connect Telegram',
    async run({ config, say, link }) {
      const telegram = await config.readTelegram();
      if (!telegram) return link('telegram');
      say(
        `Connected to @${telegram.botUsername}. I message you there about reviews and blockers, ` +
          'and you can reply from your phone.\n' +
          paint.dim('Run /telegram-disconnect to link a different bot.'),
      );
    },
  },
  {
    name: 'telegram-disconnect',
    description: 'Unlink your Telegram bot and link a new one',
    async run({ config, say, link, unlink }) {
      const telegram = await config.readTelegram();
      if (telegram) {
        await unlink('telegram');
        say(
          `Disconnected @${telegram.botUsername}. Let’s link a new one, or press Ctrl-C to stay unlinked.`,
        );
      }
      await link('telegram');
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

/** The live menu under the input: commands matching what's typed after "/". */
export function commandMenu(text: string): MenuItem[] {
  if (!text.startsWith('/') || text.includes(' ')) return [];
  const typed = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(typed)),
  ).map((c) => ({ value: `/${c.name}`, hint: c.description }));
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

export interface Usage {
  runs: number;
  tokens: number;
  costUsd: number;
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week',
  seven_day_opus: 'Current week (Opus)',
  seven_day_sonnet: 'Current week (Sonnet)',
};

const BAR_WIDTH = 40;

/** Subscription limits, laid out like Claude Code's own /usage. */
export function limitsReport(
  plan: string,
  limits: Limits | undefined,
  { live = false, now = new Date() }: { live?: boolean; now?: Date } = {},
): string {
  const lines = [paint.bold(plan)];
  if (!limits || limits.windows.length === 0) {
    lines.push('', paint.dim('No reading yet. Limits update every time Dazza replies.'));
    return lines.join('\n');
  }
  for (const window of limits.windows) {
    const percent = Math.round(window.utilization * 100);
    lines.push(
      '',
      WINDOW_NAMES[window.id] ?? window.id,
      `${bar(window.utilization)}  ${percent}% used`,
      paint.dim(`Resets ${when(window.resetsAt, now)}`),
    );
  }
  lines.push(
    '',
    paint.dim(
      live ? 'Live.' : `Checked ${ago(limits.checkedAt, now)}, on your last message to Dazza.`,
    ),
  );
  return lines.join('\n');
}

/** Pay-as-you-go spend. The API has no balance lookup for standard keys, so link to billing. */
export function spendReport(provider: ProviderId, session: Usage, project: Usage): string {
  // Claude Code reports what each run costs; Codex doesn't, so show tokens there.
  const priced = provider === 'claude';
  const row = (label: string, usage: Usage) =>
    `${label.padEnd(16)}${priced ? `$${usage.costUsd.toFixed(2)}`.padStart(8) : ''}   ${paint.dim(
      `${usage.runs} ${usage.runs === 1 ? 'message' : 'messages'} · ${compact(usage.tokens)} tokens`,
    )}`;
  const billing =
    provider === 'codex'
      ? 'Spend, credit balance and limits: https://platform.openai.com/usage'
      : `Credit balance and limits: ${PROVIDER_HELP.claude.billing}`;
  return [
    paint.bold(`${provider === 'codex' ? 'OpenAI' : 'Anthropic'} API · pay as you go`),
    '',
    row('This session', session),
    row('This project', project),
    '',
    paint.dim(billing),
  ].join('\n');
}

/** A bar with eighth-block precision, so small percentages still show. */
function bar(fraction: number, width = BAR_WIDTH): string {
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = eighths % 8 ? (' ▏▎▍▌▋▊▉'[eighths % 8] ?? '') : '';
  const filled = '█'.repeat(full) + partial;
  return paint.hex(BRAND, filled) + paint.dim('░'.repeat(width - filled.length));
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
