import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Per-user state that isn't about any one project: preferences, and the latest
 * rate-limit reading (limits are per account, so every project shares them).
 * Lives in ~/.config/dazza, or $DAZZA_CONFIG_DIR.
 */

export const Settings = z.object({
  /** Model id passed to the agent CLI; unset means the provider's default. */
  model: z.string().optional(),
  /** Desktop notifications when a task needs the user. Unset means on. */
  desktopNotifications: z.boolean().optional(),
  /** How many independent tasks to build at once (1–3). Unset means 2. */
  parallelTasks: z.number().int().min(1).max(3).optional(),
  /** The user chose not to connect Slack or Telegram during onboarding; don't ask again. */
  messagingSkipped: z.boolean().optional(),
});
export type Settings = z.infer<typeof Settings>;

/**
 * How Dazza reaches its coding agent: Claude Code or Codex, through the user's
 * own sign-in (subscription) or an API key. Holds a secret for API keys, so the
 * file is 0600.
 */
export const Connection = z.union([
  z.object({ provider: z.enum(['claude', 'codex']), method: z.literal('subscription') }),
  z.object({
    provider: z.enum(['claude', 'codex']),
    method: z.literal('api-key'),
    apiKey: z.string().min(1),
  }),
]);
export type Connection = z.infer<typeof Connection>;

/** The Telegram bot Dazza messages the user through. The token is a secret, hence 0600. */
export const TelegramLink = z.object({
  botToken: z.string().min(1),
  botUsername: z.string(),
  chatId: z.string().min(1),
});
export type TelegramLink = z.infer<typeof TelegramLink>;

/**
 * The Slack app Dazza messages the user through, in a DM. Holds two secrets: the
 * bot token (to post) and the app-level token (to receive, over Socket Mode).
 */
export const SlackLink = z.object({
  botToken: z.string().startsWith('xoxb-'),
  appToken: z.string().startsWith('xapp-'),
  appId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  /** The user Dazza works for; messages and clicks from anyone else are ignored. */
  userId: z.string(),
  /** The DM between the user and the bot. */
  channelId: z.string(),
});
export type SlackLink = z.infer<typeof SlackLink>;

export const Limits = z.object({
  checkedAt: z.iso.datetime(),
  windows: z.array(
    z.object({ id: z.string(), utilization: z.number(), resetsAt: z.iso.datetime() }),
  ),
});
export type Limits = z.infer<typeof Limits>;

export class Config {
  constructor(readonly dir = defaultConfigDir()) {}

  async readSettings(): Promise<Settings> {
    return (await this.read('settings.json', Settings)) ?? {};
  }

  async updateSettings(changes: Settings): Promise<Settings> {
    const next = { ...(await this.readSettings()), ...changes };
    await this.write('settings.json', next);
    return next;
  }

  readConnection(): Promise<Connection | undefined> {
    return this.read('connection.json', Connection);
  }

  writeConnection(connection: Connection): Promise<void> {
    return this.write('connection.json', connection);
  }

  /** Sign out of Dazza. Leaves the agent CLI's own sign-in alone. */
  async clearConnection(): Promise<void> {
    await rm(join(this.dir, 'connection.json'), { force: true });
  }

  readTelegram(): Promise<TelegramLink | undefined> {
    return this.read('telegram.json', TelegramLink);
  }

  writeTelegram(link: TelegramLink): Promise<void> {
    return this.write('telegram.json', link);
  }

  async clearTelegram(): Promise<void> {
    await rm(join(this.dir, 'telegram.json'), { force: true });
  }

  readSlack(): Promise<SlackLink | undefined> {
    return this.read('slack.json', SlackLink);
  }

  writeSlack(link: SlackLink): Promise<void> {
    return this.write('slack.json', link);
  }

  async clearSlack(): Promise<void> {
    await rm(join(this.dir, 'slack.json'), { force: true });
  }

  /** Where one Dazza window claims the Slack connection, so replies don't go astray. */
  get slackLockFile(): string {
    return join(this.dir, 'slack.lock');
  }

  readLimits(): Promise<Limits | undefined> {
    return this.read('limits.json', Limits);
  }

  writeLimits(limits: Limits): Promise<void> {
    return this.write('limits.json', limits);
  }

  private async read<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(join(this.dir, file), 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Owner-only permissions: this directory holds API keys and bot tokens. */
  private async write(file: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, file);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

function defaultConfigDir(): string {
  if (process.env.DAZZA_CONFIG_DIR) return process.env.DAZZA_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dazza');
}
