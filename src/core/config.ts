import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { JEV_PROVIDER_IDS } from '../jev/providers.js';
import { isSealed, type SecretStore, secretStore } from './keychain.js';

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
  /**
   * The chat can use the MCP servers the user has in Claude Code or Codex
   * (email, calendar, docs, trackers). Unset means on. Builders never get them.
   */
  userMcp: z.boolean().optional(),
  /** Keep building after the terminal closes (`/background on`). Unset means off. */
  backgroundBuild: z.boolean().optional(),
  /**
   * Approving work from Slack or Telegram merges it. Off (`/phone-merge off`)
   * means it's merged only from the terminal or the board, so someone in the
   * user's Slack or Telegram can't. Unset means on.
   */
  phoneMerge: z.boolean().optional(),
  /**
   * Start tasks on top of work that's waiting for review, instead of waiting
   * for the user to approve it (`/build-ahead off` waits). Unset means on.
   */
  buildAhead: z.boolean().optional(),
  /** One-off tips already shown, so each is said once (e.g. 'background' on leaving mid-build). */
  tipsShown: z.array(z.string()).optional(),
  /** The user chose not to connect Slack or Telegram during onboarding; don't ask again. */
  messagingSkipped: z.boolean().optional(),
  /**
   * What Jev does, each on its own (`/jev`). Only with Jev connected; then
   * unset means on, since connecting it was the choice to use it.
   */
  jev: z
    .object({
      /** Pick each task's model from what it needs, up to the one chosen with /model. */
      modelRouting: z.boolean().optional(),
      /** Send a handoff back to its builder when the evidence doesn't show the work is done. */
      scopeCheck: z.boolean().optional(),
    })
    .optional(),
});
export type Settings = z.infer<typeof Settings>;

/** Independent tasks built at once, unless the user chose otherwise (/parallel). */
export const DEFAULT_PARALLEL = 2;

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

/** Where Dazza calls Jev, and the key for it. A secret, hence 0600 and the keychain. */
export const JevLink = z.object({
  provider: z.enum(JEV_PROVIDER_IDS),
  apiKey: z.string().min(1),
});
export type JevLink = z.infer<typeof JevLink>;

export const Limits = z.object({
  checkedAt: z.iso.datetime(),
  windows: z.array(
    z.object({ id: z.string(), utilization: z.number(), resetsAt: z.iso.datetime() }),
  ),
});
export type Limits = z.infer<typeof Limits>;

/** When Dazza last asked npm for its latest version, and the answer. */
export const UpdateCheck = z.object({ checkedAt: z.iso.datetime(), latest: z.string() });
export type UpdateCheck = z.infer<typeof UpdateCheck>;

/** The fields that are secrets, per file. They go to the OS's secret store when it has one. */
const SECRET_FIELDS: Record<string, readonly string[]> = {
  'connection.json': ['apiKey'],
  'telegram.json': ['botToken'],
  'slack.json': ['botToken', 'appToken'],
  'jev.json': ['apiKey'],
};

export class Config {
  constructor(
    readonly dir = defaultConfigDir(),
    /** Where secrets go instead of the files; undefined keeps them in the files. */
    readonly secrets: SecretStore | undefined = secretStore(),
  ) {}

  /** Where each secret is kept, for `dazza doctor`. Empty when none are saved. */
  async secretsKeptIn(): Promise<string[]> {
    const places = new Set<string>();
    for (const [file, fields] of Object.entries(SECRET_FIELDS)) {
      const raw = await this.readRaw(file);
      for (const field of fields) {
        const place = this.placeOf(raw?.[field]);
        if (place) places.add(place);
      }
    }
    return [...places];
  }

  /** Where the Jev key is kept, if there is one. */
  async jevKeyKeptIn(): Promise<string | undefined> {
    return this.placeOf((await this.readRaw('jev.json'))?.apiKey);
  }

  private placeOf(value: unknown): string | undefined {
    if (isSealed(value)) return this.secrets?.name ?? 'the system’s secret store';
    if (typeof value === 'string') return 'Dazza’s config folder (owner-only)';
    return undefined;
  }

  async readSettings(): Promise<Settings> {
    return (await this.read('settings.json', Settings)) ?? {};
  }

  /** True the first time a tip is asked about, then never again. */
  async firstTime(tip: string): Promise<boolean> {
    const shown = (await this.readSettings()).tipsShown ?? [];
    if (shown.includes(tip)) return false;
    await this.updateSettings({ tipsShown: [...shown, tip] });
    return true;
  }

  async updateSettings(changes: Settings): Promise<Settings> {
    const next = { ...(await this.readSettings()), ...changes };
    await this.write('settings.json', next);
    return next;
  }

  readUpdateCheck(): Promise<UpdateCheck | undefined> {
    return this.read('update.json', UpdateCheck);
  }

  writeUpdateCheck(check: UpdateCheck): Promise<void> {
    return this.write('update.json', check);
  }

  readConnection(): Promise<Connection | undefined> {
    return this.read('connection.json', Connection);
  }

  writeConnection(connection: Connection): Promise<void> {
    return this.write('connection.json', connection);
  }

  /** Sign out of Dazza. Leaves the agent CLI's own sign-in alone. */
  async clearConnection(): Promise<void> {
    await this.remove('connection.json');
  }

  readTelegram(): Promise<TelegramLink | undefined> {
    return this.read('telegram.json', TelegramLink);
  }

  writeTelegram(link: TelegramLink): Promise<void> {
    return this.write('telegram.json', link);
  }

  async clearTelegram(): Promise<void> {
    await this.remove('telegram.json');
  }

  readSlack(): Promise<SlackLink | undefined> {
    return this.read('slack.json', SlackLink);
  }

  writeSlack(link: SlackLink): Promise<void> {
    return this.write('slack.json', link);
  }

  async clearSlack(): Promise<void> {
    await this.remove('slack.json');
  }

  readJev(): Promise<JevLink | undefined> {
    return this.read('jev.json', JevLink);
  }

  writeJev(link: JevLink): Promise<void> {
    return this.write('jev.json', link);
  }

  async clearJev(): Promise<void> {
    await this.remove('jev.json');
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
    const raw = await this.readRaw(file);
    if (!raw) return undefined;
    const fields = SECRET_FIELDS[file] ?? [];
    let plain = false;
    for (const field of fields) {
      const value = raw[field];
      if (isSealed(value)) raw[field] = await this.secrets?.open(value);
      else if (typeof value === 'string') plain = true;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return undefined;
    // Saved before Dazza used the secret store (or where it had none then): move it in.
    if (plain && this.secrets) await this.write(file, parsed.data).catch(() => undefined);
    return parsed.data;
  }

  private async readRaw(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Deletes a file and the secrets it points to. */
  private async remove(file: string): Promise<void> {
    const raw = await this.readRaw(file);
    for (const field of SECRET_FIELDS[file] ?? []) {
      const value = raw?.[field];
      if (isSealed(value)) await this.secrets?.discard(value);
    }
    await rm(join(this.dir, file), { force: true });
  }

  /** The secret's name in the store: which setting, and whose config (tests and sandboxes differ). */
  private account(file: string, field: string): string {
    const name = `${file.replace(/\.json$/, '')}.${field}`;
    // Only the usual folder gets the plain name: a sandbox (DAZZA_CONFIG_DIR) must
    // never overwrite the real thing's secrets.
    return resolve(this.dir) === resolve(usualConfigDir())
      ? name
      : `${name} (${resolve(this.dir)})`;
  }

  /** Owner-only permissions: this directory holds API keys and bot tokens. */
  private async write(file: string, value: unknown): Promise<void> {
    const fields = SECRET_FIELDS[file];
    if (fields && this.secrets && typeof value === 'object' && value !== null) {
      const sealed: Record<string, unknown> = { ...value };
      for (const field of fields) {
        const secret = sealed[field];
        if (typeof secret !== 'string') continue;
        const put = await this.secrets
          .seal(this.account(file, field), secret)
          .catch(() => undefined);
        if (put) sealed[field] = put;
      }
      value = sealed;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, file);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

/** Where Dazza keeps its settings and keys. Exported for the guard, which keeps agents out of it. */
export function defaultConfigDir(): string {
  return process.env.DAZZA_CONFIG_DIR || usualConfigDir();
}

/** Where the config lives when DAZZA_CONFIG_DIR doesn't move it. */
function usualConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dazza');
}
