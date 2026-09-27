import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

/** A Block Kit block or view. Slack validates them; we only build them. */
export type Block = Record<string, unknown>;

export interface Message {
  channel: string;
  /** Plain-text fallback, shown in notifications and to screen readers. */
  text: string;
  blocks?: Block[];
  /** Post into this thread instead of the channel. */
  threadTs?: string;
}

/** Longest Slack asks us to wait out a rate limit before we give up. */
const MAX_RETRY_AFTER_S = 30;

/**
 * The Slack Web API calls Dazza needs, over plain fetch. Takes either token: the
 * bot token for posting, the app-level token for opening a Socket Mode
 * connection. Tokens travel in a header, never in URLs or errors.
 */
export class SlackApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Who the token belongs to; also how a bot token is checked. */
  async authTest(): Promise<{ teamId: string; team: string; botId?: string }> {
    const result = await this.call(
      'auth.test',
      {},
      z.object({ team_id: z.string(), team: z.string(), bot_id: z.string().optional() }),
    );
    return {
      teamId: result.team_id,
      team: result.team,
      ...(result.bot_id && { botId: result.bot_id }),
    };
  }

  /** The app a bot belongs to, for links to its settings. */
  async appIdOf(botId: string): Promise<string> {
    const result = await this.call(
      'bots.info',
      { bot: botId },
      z.object({ bot: z.object({ app_id: z.string() }) }),
    );
    return result.bot.app_id;
  }

  /** A fresh Socket Mode URL. Needs the app-level token. */
  async openConnection(): Promise<string> {
    return (await this.call('apps.connections.open', {}, z.object({ url: z.string() }))).url;
  }

  async postMessage(message: Message): Promise<{ channel: string; ts: string }> {
    return this.call(
      'chat.postMessage',
      {
        channel: message.channel,
        text: message.text,
        unfurl_links: false,
        ...(message.blocks && { blocks: message.blocks }),
        ...(message.threadTs && { thread_ts: message.threadTs }),
      },
      z.object({ channel: z.string(), ts: z.string() }),
    );
  }

  async updateMessage(channel: string, ts: string, text: string, blocks: Block[]): Promise<void> {
    await this.call('chat.update', { channel, ts, text, blocks }, z.unknown());
  }

  async react(channel: string, ts: string, name: string, on: boolean): Promise<void> {
    await this.call(
      on ? 'reactions.add' : 'reactions.remove',
      { channel, timestamp: ts, name },
      z.unknown(),
    );
  }

  /** Open a modal in answer to a click (the trigger expires after 3 seconds). */
  async openView(triggerId: string, view: Block): Promise<void> {
    await this.call('views.open', { trigger_id: triggerId, view }, z.unknown());
  }

  /** Replace what the user sees on the app's Home tab. */
  async publishHome(userId: string, view: Block): Promise<void> {
    await this.call('views.publish', { user_id: userId, view }, z.unknown());
  }

  /** Share image files in a channel, as one message, optionally in a thread. */
  async uploadFiles(channel: string, files: string[], threadTs?: string): Promise<void> {
    const uploaded: { id: string; title: string }[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      const target = await this.call(
        'files.getUploadURLExternal',
        { filename: basename(file), length: bytes.length },
        z.object({ upload_url: z.string(), file_id: z.string() }),
      );
      const res = await this.fetchImpl(target.upload_url, { method: 'POST', body: bytes });
      if (!res.ok) throw new SlackError(`upload_failed_${res.status}`);
      uploaded.push({ id: target.file_id, title: basename(file) });
    }
    if (uploaded.length === 0) return;
    await this.call(
      'files.completeUploadExternal',
      { files: uploaded, channel_id: channel, ...(threadTs && { thread_ts: threadTs }) },
      z.unknown(),
    );
  }

  /**
   * Call a Web API method. Arguments go form-encoded, which every method
   * accepts; structured values (blocks, views) are sent as JSON strings.
   * A rate limit is waited out once.
   */
  private async call<T>(method: string, args: object, result: z.ZodType<T>): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        body,
      });
      const wait = Number(res.headers.get('retry-after') ?? 1);
      if (res.status === 429 && attempt === 0 && wait <= MAX_RETRY_AFTER_S) {
        await sleep(wait * 1000);
        continue;
      }
      const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new SlackError(`unexpected_response_${res.status}`);
      if (!parsed.data.ok) throw new SlackError(parsed.data.error ?? 'unknown_error');
      return result.parse(parsed.data);
    }
  }
}

/** Slack's own error code, e.g. "invalid_auth" or "not_allowed_token_type". */
export class SlackError extends Error {
  constructor(readonly code: string) {
    super(describeError(code));
    this.name = 'SlackError';
  }
}

const Envelope = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

function describeError(code: string): string {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return 'Slack didn’t accept the token';
    case 'not_allowed_token_type':
      return 'that’s the wrong kind of token';
    case 'missing_scope':
      return 'the Slack app is missing a permission';
    case 'channel_not_found':
    case 'not_in_channel':
      return 'the bot can’t reach that conversation';
    case 'ratelimited':
      return 'Slack is rate-limiting us';
    default:
      return `Slack said “${code}”`;
  }
}
