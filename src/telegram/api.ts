import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';

/** Buttons under a message, e.g. Approve / Request changes. */
export type Keyboard = { text: string; callback_data: string }[][];

/**
 * The Telegram Bot API calls Dazza needs, over plain fetch. The token is
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
      {
        timeout,
        allowed_updates: ['message', 'callback_query'],
        ...(offset !== undefined && { offset }),
      },
      z.array(Update),
      signal,
    );
  }

  /** Send a message; resolves its id, so it can be edited or replied to. */
  async sendMessage(
    chatId: string,
    text: string,
    options: { keyboard?: Keyboard; replyTo?: number; forceReply?: boolean } = {},
  ): Promise<number> {
    const markup = options.keyboard
      ? { inline_keyboard: options.keyboard }
      : options.forceReply
        ? { force_reply: true }
        : undefined;
    const sent = await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(markup && { reply_markup: markup }),
        ...(options.replyTo && { reply_parameters: { message_id: options.replyTo } }),
      },
      z.object({ message_id: z.number() }),
    );
    return sent.message_id;
  }

  /** Replace a message's buttons, or remove them. */
  async setKeyboard(chatId: string, messageId: number, keyboard?: Keyboard): Promise<void> {
    await this.call(
      'editMessageReplyMarkup',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard ?? [] },
      },
      z.unknown(),
    );
  }

  /** Acknowledge a button press, so Telegram stops showing it as loading. */
  async answerButton(callbackId: string, text?: string): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      { callback_query_id: callbackId, ...(text && { text }) },
      z.unknown(),
    );
  }

  /** Send an image file, with an optional caption (Telegram allows 1024 characters). */
  async sendPhoto(chatId: string, file: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('photo', new Blob([await readFile(file)], { type: 'image/png' }), basename(file));
    if (caption) form.set('caption', caption.slice(0, 1024));
    await this.request('sendPhoto', { body: form }, z.unknown());
  }

  private async call<T>(
    method: string,
    body: object,
    result: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(
      method,
      {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        ...(signal && { signal }),
      },
      result,
    );
  }

  private async request<T>(method: string, init: RequestInit, result: z.ZodType<T>): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      ...init,
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

const Chat = z.object({ id: z.number(), type: z.string(), first_name: z.string().optional() });

export const Update = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number().default(0),
      chat: Chat,
      text: z.string().optional(),
      /** The message this one replies to, e.g. a notification or a "what should change?" */
      reply_to_message: z.object({ message_id: z.number() }).optional(),
    })
    .optional(),
  /** A button press. */
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: Chat }).optional(),
    })
    .optional(),
});
export type Update = z.infer<typeof Update>;
