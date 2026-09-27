import { z } from 'zod';

/**
 * The three Telegram Bot API calls Dazza needs, over plain fetch. The token is
 * part of every URL, so it's never logged: errors carry Telegram's description only.
 */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The bot's own account; also how a token is checked. */
  async getMe(): Promise<{ username: string; name: string }> {
    const me = await this.call('getMe', {}, BotUser);
    return { username: me.username, name: me.first_name };
  }

  /** Messages sent to the bot since `offset`, waiting up to `timeout` seconds for one. */
  async getUpdates(
    offset: number | undefined,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Update[]> {
    return this.call(
      'getUpdates',
      { timeout, allowed_updates: ['message'], ...(offset !== undefined && { offset }) },
      z.array(Update),
      signal,
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call(
      'sendMessage',
      { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
      z.unknown(),
    );
  }

  private async call<T>(
    method: string,
    body: object,
    result: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal && { signal }),
    });
    const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success)
      throw new TelegramError(`Unexpected reply from Telegram (${res.status})`, res.status);
    if (!parsed.data.ok) {
      throw new TelegramError(
        parsed.data.description ?? 'Telegram refused the request',
        parsed.data.error_code ?? res.status,
      );
    }
    return result.parse(parsed.data.result);
  }
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
});

const BotUser = z.object({ username: z.string(), first_name: z.string() });

export const Update = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: z.number(), type: z.string(), first_name: z.string().optional() }),
      text: z.string().optional(),
    })
    .optional(),
});
export type Update = z.infer<typeof Update>;
