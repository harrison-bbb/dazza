import { type Config, DEFAULT_PARALLEL, type Settings } from '../core/config.js';

/**
 * Everything the user can change about how Dazza works, in one place: what
 * `/settings` lists. Each has a sensible default, so most people never open it.
 */

interface Option<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface SettingDef<T = unknown> {
  key: keyof Settings;
  label: string;
  /** What it does, in a line. */
  about: string;
  options: Option<T>[];
  /** The value now, defaults filled in. */
  current(settings: Settings): T;
  /** What changing it takes, beyond saving it (e.g. reopening notifications). */
  after?: 'reconnect';
}

const onOff = (on: string, off: string): Option<boolean>[] => [
  { label: 'On', value: true, hint: on },
  { label: 'Off', value: false, hint: off },
];

export const SETTINGS: SettingDef[] = [
  {
    key: 'buildAhead',
    label: 'Keep building while you review',
    about: 'Start the next tasks on top of work waiting for your review.',
    options: onOff('the next tasks start straight away', 'wait until you approve'),
    current: (s) => s.buildAhead !== false,
  } satisfies SettingDef<boolean>,
  {
    key: 'backgroundBuild',
    label: 'Keep building after you close Dazza',
    about: 'Carry on in the background; `dazza stop` or "stop" from your phone stops it.',
    options: onOff('builds on with the terminal closed', 'closing Dazza stops the build'),
    current: (s) => s.backgroundBuild === true,
  } satisfies SettingDef<boolean>,
  {
    key: 'parallelTasks',
    label: 'Tasks built at once',
    about: 'More finishes sooner, but uses your plan’s limits faster.',
    options: [
      { label: '1', value: 1, hint: 'one at a time, gentlest on your limits' },
      { label: '2', value: 2, hint: 'the default' },
      { label: '3', value: 3, hint: 'fastest, uses your limits fastest' },
    ],
    current: (s) => s.parallelTasks ?? DEFAULT_PARALLEL,
  } satisfies SettingDef<number>,
  {
    key: 'buildSteps',
    label: 'Show every build step',
    about: 'Every file and command builders touch, or just the highlights. Ctrl+O switches.',
    options: onOff(
      'every read, edit and command, as it happens',
      'what started, what’s done, what needs you',
    ),
    current: (s) => s.buildSteps === true,
  } satisfies SettingDef<boolean>,
  {
    key: 'desktopNotifications',
    label: 'Desktop notifications',
    about: 'A notification on this computer when a task needs you.',
    options: onOff('when a task needs you', 'no notifications'),
    current: (s) => s.desktopNotifications !== false,
    after: 'reconnect',
  } satisfies SettingDef<boolean>,
  {
    key: 'phoneMerge',
    label: 'Approving from your phone merges',
    about: 'Off keeps merging to this computer, so someone in your Slack or Telegram can’t.',
    options: onOff('Approve on Slack or Telegram merges', 'approve here or on the board'),
    current: (s) => s.phoneMerge !== false,
  } satisfies SettingDef<boolean>,
  {
    key: 'userMcp',
    label: 'Use your MCP servers in chat',
    about: 'Your email, docs and trackers from Claude Code or Codex. Builders never get them.',
    options: onOff('Dazza can use them, and asks before changing anything', 'Dazza won’t'),
    current: (s) => s.userMcp !== false,
  } satisfies SettingDef<boolean>,
] as SettingDef[];

/** How a value reads in the list, e.g. "On", "2". */
export function shown(setting: SettingDef, settings: Settings): string {
  const value = setting.current(settings);
  return setting.options.find((o) => o.value === value)?.label ?? String(value);
}

type Pick = <T>(
  question: string,
  choices: { label: string; hint?: string; value: T }[],
) => Promise<T | undefined>;

/**
 * `/settings`: the list with each value, pick one to change it, and back to
 * the list until they're done (Esc). Resolves what changed, in words.
 */
export async function editSettings(
  config: Config,
  select: Pick,
  afterChange: (setting: SettingDef) => Promise<void>,
): Promise<string[]> {
  const changed: string[] = [];
  for (;;) {
    const settings = await config.readSettings();
    const width = Math.max(...SETTINGS.map((s) => s.label.length));
    const setting = await select(
      'Settings: pick one to change it, Esc when you’re done',
      SETTINGS.map((s) => ({
        label: `${s.label.padEnd(width)}  ${shown(s, settings)}`,
        hint: s.about,
        value: s,
      })),
    );
    if (!setting) return changed;
    const now = setting.current(settings);
    const value = await select(
      setting.label,
      setting.options.map((o) => ({
        label: o.value === now ? `${o.label} (now)` : o.label,
        ...(o.hint && { hint: o.hint }),
        value: o.value,
      })),
    );
    if (value === undefined || value === now) continue;
    await config.updateSettings({ [setting.key]: value } as Settings);
    await afterChange(setting);
    changed.push(`${setting.label}: ${shown(setting, await config.readSettings())}`);
  }
}
