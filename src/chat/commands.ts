import { approvePlan } from '../core/actions.js';
import { type Config, type Connection, DEFAULT_PARALLEL, type Limits } from '../core/config.js';
import { clock } from '../core/errors.js';
import type { Store } from '../core/store.js';
import type { ChannelId } from '../notify/channel.js';
import { PROVIDER_HELP } from '../providers/index.js';
import type { AgentProvider, ModelOption, ProviderId } from '../providers/types.js';
import { openInBrowser } from '../util/open.js';
import { BRAND } from './banner.js';
import { greeting, NO_PLAN } from './describe.js';
import type { MenuItem } from './editor.js';
import { projectEstimate } from './progress.js';
import { editSettings } from './settings.js';
import { paint } from './style.js';
import { WORK_COMMANDS } from './workCommands.js';

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
  /** Have Dazza write the progress (or close-out) report. */
  requestReport(): Promise<void>;
  /** Summarise the conversation to free up room; says how it went. */
  compact(): Promise<string>;
  /** How full the conversation is: tokens as of the last reply, and the model's window. */
  context(): { tokens?: number; window: number };
  /** A different conversation: its size isn't known until the next reply. */
  resetContext(): void;
  /** Whether Dazza is in the middle of a reply. */
  chatting(): boolean;
  /** Whether a build is on, so work put back in the queue gets picked up by itself. */
  building(): boolean;
  /** Stop the build; the current task is paused. */
  stopBuild(): Promise<void>;
  /** Ask the user a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Let the user pick from a list; undefined if they back out (Esc). */
  select<T>(
    question: string,
    choices: { label: string; hint?: string; value: T }[],
  ): Promise<T | undefined>;
  /** Show (or clear) an activity in the status line while a command works. */
  status(text: string | undefined): void;
  /** Walk through linking Slack or a Telegram bot. */
  link(channel: ChannelId): Promise<void>;
  /** Forget the Slack app or Telegram bot. */
  unlink(channel: ChannelId): Promise<void>;
  /** Reopen notification channels after a settings change. */
  reconnect(): Promise<void>;
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
    async run({ store, config, say }) {
      const plan = await store.readPlan();
      say(plan ? greeting(plan, await projectEstimate(store, config)) : NO_PLAN);
    },
  },
  ...WORK_COMMANDS,
  {
    name: 'report',
    description: 'Write up where the project is: a progress report, or the close-out at the end',
    async run({ store, say, requestReport }) {
      const plan = await store.readPlan();
      if (!plan) return say(NO_PLAN);
      if (!plan.approvedAt) return say('There’s nothing to report yet: the plan isn’t approved.');
      await requestReport();
    },
  },
  {
    name: 'approve',
    description: 'Approve the drafted plan so Dazza can start',
    async run({ store, say }, args) {
      // Tasks are approved with /accept; "/approve T3" is an easy slip to make.
      const task = args.trim().toUpperCase();
      if (/^T\d+$/.test(task))
        return say(`To approve ${task}’s work and merge it, use /accept ${task}.`);
      const result = await approvePlan(store);
      say(
        result.ok
          ? `${paint.green('✔')} ${result.message} Run ${paint.bold('/build')} when you want me to start.`
          : result.message,
      );
    },
  },
  {
    name: 'background',
    args: '[on|off]',
    description: 'Keep building after you close the terminal (off unless you switch it on)',
    async run({ config, say }, args) {
      const choice = args.trim().toLowerCase();
      if (choice === 'on' || choice === 'off') {
        await config.updateSettings({ backgroundBuild: choice === 'on' });
        return say(
          choice === 'on'
            ? 'On. When you leave with a build under way, it carries on in the background: on this computer, while it’s awake. Stop it with `dazza stop` from any terminal, or "stop" from Slack or Telegram. Opening `dazza` here takes it back.'
            : 'Off. Closing Dazza stops the build, and the current task picks up where it left off next time.',
        );
      }
      const on = (await config.readSettings()).backgroundBuild === true;
      say(
        on
          ? 'Building in the background is on: leave with a build under way and it carries on. /background off switches it off.'
          : 'Building in the background is off: closing Dazza stops the build. /background on keeps it going after you leave.',
      );
    },
  },
  {
    name: 'settings',
    aliases: ['config'],
    description:
      'How Dazza works: building while you review or after you leave, notifications, and more',
    async run({ config, select, say, reconnect }) {
      const changed = await editSettings(config, select, async (setting) => {
        if (setting.after === 'reconnect') await reconnect();
      });
      say(
        changed.length > 0
          ? `${paint.green('✔')} ${changed.join(' · ')}`
          : paint.dim('Nothing changed.'),
      );
    },
  },
  {
    name: 'build-ahead',
    args: '[on|off]',
    description:
      'Start the next tasks while earlier work waits for your review (on unless you switch it off)',
    async run({ config, say }, args) {
      const choice = args.trim().toLowerCase();
      if (choice === 'on' || choice === 'off') {
        await config.updateSettings({ buildAhead: choice === 'on' });
        return say(
          choice === 'on'
            ? 'On. When a task is waiting for your review, the tasks that need it start on top of its work, so building doesn’t stop until you get to it. If you send it back or start it over, what was built on it follows.'
            : 'Off. Tasks wait until the work they need is approved.',
        );
      }
      const on = (await config.readSettings()).buildAhead !== false;
      say(
        on
          ? 'Building ahead is on: the next tasks start on top of work waiting for your review. /build-ahead off waits for approval instead.'
          : 'Building ahead is off: tasks wait until the work they need is approved. /build-ahead on keeps building.',
      );
    },
  },
  {
    name: 'phone-merge',
    args: '[on|off]',
    description:
      'Whether approving from Slack or Telegram merges the work (on unless you switch it off)',
    async run({ config, say }, args) {
      const choice = args.trim().toLowerCase();
      if (choice === 'on' || choice === 'off') {
        await config.updateSettings({ phoneMerge: choice === 'on' });
        return say(
          choice === 'on'
            ? 'On. Approving from Slack or Telegram merges the work.'
            : 'Off. Work is merged only from here or the board, so someone in your Slack or Telegram can’t merge code. Your phone still gets everything else.',
        );
      }
      const on = (await config.readSettings()).phoneMerge !== false;
      say(
        on
          ? 'Approving from Slack or Telegram merges the work. /phone-merge off keeps merging to here and the board.'
          : 'Merging from Slack or Telegram is off: approve work here or on the board. /phone-merge on allows it again.',
      );
    },
  },
  {
    name: 'mcp',
    args: '[on|off]',
    description:
      'Your Claude Code or Codex MCP servers: list them, or switch them on or off for Dazza',
    async run({ config, provider, store, say, status }, args) {
      const choice = args.trim().toLowerCase();
      if (choice === 'on' || choice === 'off') {
        await config.updateSettings({ userMcp: choice === 'on' });
        return say(
          choice === 'on'
            ? 'Dazza can use your MCP servers again, from your next message. Builders never get them.'
            : 'Dazza won’t use your MCP servers. /mcp on switches them back on.',
        );
      }
      const on = (await config.readSettings()).userMcp !== false;
      status(`Checking your ${provider.name} MCP servers`);
      const servers = await provider.listMcpServers(store.root).finally(() => status(undefined));
      if (servers.length === 0) {
        return say(`You have no MCP servers set up in ${provider.name}.`);
      }
      say(
        [
          `Your ${provider.name} MCP servers, which Dazza ${on ? 'can use in our conversation' : 'isn’t using (/mcp on)'}:`,
          ...servers.map((s) => `  ${s.name} ${paint.dim(`· ${s.status}`)}`),
          paint.dim(
            `Builders don’t get these. Add or sign in to servers in ${provider.name} itself.${on ? ' /mcp off switches them off here.' : ''}`,
          ),
        ].join('\n'),
      );
    },
  },
  {
    name: 'context',
    description: 'How full our conversation is, and when /compact is worth it',
    run({ context, say }) {
      const { tokens, window } = context();
      if (tokens === undefined) return say('Not measured yet: I’ll know after my next reply.');
      const percent = Math.round((tokens / window) * 100);
      say(
        `Our conversation is about ${Math.round(tokens / 1000)}k tokens: ${percent}% of the ${Math.round(window / 1000)}k this model holds.` +
          (percent >= 50
            ? ' /compact frees up room.'
            : paint.dim(' Plenty of room. /compact frees some up when it gets full.')),
      );
    },
  },
  {
    name: 'compact',
    description: 'Summarise our conversation to free up room, like /compact in Claude Code',
    async run({ compact, say }) {
      say(await compact());
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
    name: 'notify',
    args: '[on|off]',
    description: 'Desktop notifications when a task needs you',
    async run({ config, say, reconnect }, args) {
      const choice = args.trim().toLowerCase();
      if (choice !== 'on' && choice !== 'off') {
        const on = (await config.readSettings()).desktopNotifications !== false;
        say(
          `Desktop notifications are ${on ? 'on' : 'off'}. ${paint.dim(`/notify ${on ? 'off' : 'on'} to turn them ${on ? 'off' : 'on'}.`)}`,
        );
        return;
      }
      await config.updateSettings({ desktopNotifications: choice === 'on' });
      await reconnect();
      say(`${paint.green('✔')} Desktop notifications ${choice}.`);
    },
  },
  {
    name: 'parallel',
    args: '[1–3]',
    description: 'How many independent tasks to build at once',
    async run({ config, say }, args) {
      const current = (await config.readSettings()).parallelTasks ?? DEFAULT_PARALLEL;
      const wanted = Number(args.trim());
      if (!args.trim()) {
        say(
          `Building up to ${current} independent task${current === 1 ? '' : 's'} at once. ` +
            paint.dim(
              '/parallel 1 to build one at a time, up to /parallel 3. More at once finishes sooner but uses your limits faster.',
            ),
        );
        return;
      }
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 3) {
        say('Pick 1, 2 or 3.');
        return;
      }
      await config.updateSettings({ parallelTasks: wanted });
      say(
        `${paint.green('✔')} Up to ${wanted} task${wanted === 1 ? '' : 's'} at once, from the next task that starts.`,
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
    async run({ store, say, chatting, resetContext }) {
      if (chatting()) return say('I’m still replying. Try /new once I’ve answered.');
      await store.newConversation();
      resetContext();
      say(
        'Fresh conversation. The plan and the board are as they were. What’s next? ' +
          paint.dim('(/continue goes back to the last one.)'),
      );
    },
  },
  {
    name: 'continue',
    aliases: ['resume'],
    description: 'Pick up our last conversation, like dazza --continue',
    async run({ store, provider, say, chatting, resetContext }) {
      if (chatting()) return say('I’m still replying. Try /continue once I’ve answered.');
      resetContext();
      say(
        (await store.continueConversation(provider.id))
          ? 'Back to our last conversation. Carry on where we left off.'
          : 'There’s no earlier conversation here to go back to.',
      );
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
    description: 'See your Slack link, or connect Slack (/slack-disconnect to unlink)',
    async run({ config, say, link }) {
      const slack = await config.readSlack();
      if (!slack) return link('slack');
      say(
        `Connected to ${slack.teamName}. I message you there about reviews and blockers, ` +
          'and you can reply, approve work and start builds from Slack.\n' +
          paint.dim('/slack-disconnect unlinks it; then /slack links a different workspace.'),
      );
    },
  },
  {
    name: 'slack-disconnect',
    description: 'Unlink Slack',
    async run({ config, say, unlink }) {
      const slack = await config.readSlack();
      if (!slack) return say('Slack isn’t linked. /slack links it.');
      await unlink('slack');
      say(
        `Disconnected from ${slack.teamName}. /slack links it again. ` +
          paint.dim('To remove the app itself, delete it at https://api.slack.com/apps.'),
      );
    },
  },
  {
    name: 'telegram',
    description: 'See your Telegram link, or connect Telegram (/telegram-disconnect to unlink)',
    async run({ config, say, link }) {
      const telegram = await config.readTelegram();
      if (!telegram) return link('telegram');
      say(
        `Connected to @${telegram.botUsername}. I message you there about reviews and blockers, ` +
          'and you can reply from your phone.\n' +
          paint.dim('/telegram-disconnect unlinks it; then /telegram links a different bot.'),
      );
    },
  },
  {
    name: 'telegram-disconnect',
    description: 'Unlink your Telegram bot',
    async run({ config, say, unlink }) {
      const telegram = await config.readTelegram();
      if (!telegram) return say('Telegram isn’t linked. /telegram links it.');
      await unlink('telegram');
      say(`Disconnected @${telegram.botUsername}. /telegram links a bot again.`);
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

/** /help's sections, in the README's order. Anything unlisted goes under Setup. */
const HELP_GROUPS: [string, string[]][] = [
  ['The work', ['build', 'stop', 'status', 'tasks', 'next']],
  ['Reviewing', ['review', 'try', 'accept', 'changes', 'diff', 'allow', 'deny', 'redo', 'cancel']],
  [
    'The project',
    ['approve', 'scope', 'dashboard', 'report', 'continue', 'new', 'compact', 'context'],
  ],
  ['Setup', ['settings', 'model', 'mcp', 'usage', 'slack', 'telegram', 'logout', 'help', 'exit']],
];
/** In the menu as you type, but not worth a row in /help. */
const SETTING_SHORTCUTS = '/build-ahead, /background, /parallel, /notify, /phone-merge';
const HELP_HIDDEN = new Set([
  'slack-disconnect',
  'telegram-disconnect',
  // In /settings; the commands still work for anyone who knows them.
  'background',
  'build-ahead',
  'parallel',
  'notify',
  'phone-merge',
]);

export function helpText(): string {
  const row = (c: Command) => {
    const usage = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
    return `  ${paint.hex(BRAND, usage.padEnd(26))}${paint.dim(c.description)}`;
  };
  const listed = new Set(HELP_GROUPS.flatMap(([, names]) => names));
  const sections = HELP_GROUPS.map(([title, names]) => {
    const commands = names.flatMap((name) => COMMANDS.filter((c) => c.name === name));
    if (title === 'Setup') {
      commands.push(...COMMANDS.filter((c) => !listed.has(c.name) && !HELP_HIDDEN.has(c.name)));
    }
    return [
      paint.bold(title),
      ...commands.flatMap((c) =>
        c.name === 'settings'
          ? [row(c), `  ${' '.repeat(26)}${paint.dim(`Or straight to one: ${SETTING_SHORTCUTS}`)}`]
          : [row(c)],
      ),
    ].join('\n');
  });
  const tips = paint.dim(
    'Start a line with ! to run a shell command yourself, and @ to point me at a file. Ctrl+V pastes a screenshot. \\ then Enter (or Option+Enter) starts a new line. Esc stops my reply.',
  );
  return `Just type to talk to me. Or use a command:\n${tips}\n\n${sections.join('\n\n')}`;
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
      paint.dim(`Resets ${clock(window.resetsAt, now)}`),
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
