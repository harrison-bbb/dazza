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
  /** The user chose not to set up Telegram during onboarding; don't ask again. */
  telegramSkipped: z.boolean().optional(),
});
export type Settings = z.infer<typeof Settings>;

/** How Dazza reaches its coding agent. Holds a secret for API keys, so the file is 0600. */
export const Connection = z.discriminatedUnion('method', [
  z.object({ provider: z.literal('claude'), method: z.literal('subscription') }),
  z.object({
    provider: z.literal('claude'),
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

  /** Owner-only permissions: this directory will also hold tokens later. */
  private async write(file: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, file);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

function defaultConfigDir(): string {
  if (process.env.DAZZA_CONFIG_DIR) return process.env.DAZZA_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dazza');
}
