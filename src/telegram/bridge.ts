import { setTimeout as sleep } from 'node:timers/promises';
import type { TelegramLink } from '../core/config.js';
import {
  type Channel,
  type ChannelHandlers,
  isRemoteCommand,
  type Outcome,
  type Remote,
} from '../notify/channel.js';
import type { Notification } from '../notify/notification.js';
import { type Keyboard, TelegramApi, TelegramError, type Update } from './api.js';

const POLL_SECONDS = 25;
const RETRY_MS = 5_000;
/** Telegram's limit is 4096 characters per message. */
const MAX_LENGTH = 4000;
/** Enough to find what a reply is about, without growing forever. */
const MAX_REMEMBERED = 200;

export type TelegramClient = Pick<
  TelegramApi,
  'getUpdates' | 'sendMessage' | 'sendPhoto' | 'setKeyboard' | 'answerButton'
>;

export interface BridgeOptions extends ChannelHandlers {
  api?: TelegramClient;
}

/** Button data: what to do, and to which task, e.g. "approve:T3". */
const Buttons = {
  review: (taskId: string): Keyboard => [
    [
      { text: '✅ Approve', callback_data: `approve:${taskId}` },
      { text: '↩️ Request changes', callback_data: `changes:${taskId}` },
    ],
  ],
  // Approving merges, so it takes a second tap, like Slack's confirm.
  confirm: (taskId: string): Keyboard => [
    [
      { text: `Yes, approve and merge ${taskId}`, callback_data: `confirm:${taskId}` },
      { text: 'Not yet', callback_data: `cancel:${taskId}` },
    ],
  ],
};

/**
 * Dazza's line to the user's phone while it's open: notifications with
 * Approve and Request changes buttons, and the same conversation as the
 * terminal. Only the user's own chat is listened to.
 */
export class TelegramBridge implements Channel {
  readonly id = 'telegram';
  private readonly api: TelegramClient;
  private readonly controller = new AbortController();
  private polling: Promise<void> | undefined;
  private reportedSendFailure = false;
  /** Message id → the task it's about: notifications, so replies carry their context. */
  private readonly about = new Map<number, string>();
  /** "What should change?" prompts → the task being sent back. */
  private readonly askingChanges = new Map<number, string>();
  /** Review notifications already approved or sent back. */
  private readonly decided = new Set<number>();

  constructor(
    private readonly link: TelegramLink,
    private readonly options: BridgeOptions,
  ) {
    this.api = options.api ?? new TelegramApi(link.botToken);
  }

  start(): void {
    this.polling ??= this.poll();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.polling;
  }

  async notify(note: Notification): Promise<void> {
    const id = await this.send(telegramText(note), note.images, {
      ...(note.kind === 'review' && { keyboard: Buttons.review(note.taskId) }),
    });
    if (id !== undefined && note.taskId) remember(this.about, id, note.taskId);
  }

  async reply(text: string, _to: Remote): Promise<void> {
    if (text) await this.send(text);
  }

  /** Telegram has nothing that shows the project, so nothing to update. */
  refresh(): void {}

  /**
   * Send a message, then any screenshots with it. Resolves the message's id.
   * Failures are reported, not thrown: Telegram is a side channel.
   */
  async send(
    text: string,
    images: string[] = [],
    options: { keyboard?: Keyboard; replyTo?: number; forceReply?: boolean } = {},
  ): Promise<number | undefined> {
    try {
      const parts = split(text);
      let first: number | undefined;
      for (const [i, part] of parts.entries()) {
        // Buttons go on the last part, under the whole message.
        const id = await this.api.sendMessage(
          this.link.chatId,
          part,
          i === parts.length - 1 ? options : {},
        );
        first ??= id;
      }
      for (const image of images) await this.api.sendPhoto(this.link.chatId, image);
      this.reportedSendFailure = false;
      return first;
    } catch (error) {
      if (!this.reportedSendFailure) {
        this.reportedSendFailure = true;
        this.options.onProblem(`Couldn’t send to Telegram: ${errorMessage(error)}`);
      }
      return undefined;
    }
  }

  private async poll(): Promise<void> {
    let offset: number | undefined;
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const updates = await this.api.getUpdates(offset, POLL_SECONDS, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handle(update).catch((error: unknown) =>
            this.options.onProblem(`Telegram: ${errorMessage(error)}`),
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TelegramError && error.code === 409) {
          this.options.onProblem(
            'Another Dazza window is already reading your Telegram messages, so replies will go there.',
          );
          return;
        }
        await sleep(RETRY_MS, undefined, { signal }).catch(() => {});
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    const press = update.callback_query;
    if (press) {
      await this.api.answerButton(press.id).catch(() => {});
      const message = press.message;
      if (!message || String(message.chat.id) !== this.link.chatId || !press.data) return;
      await this.onButton(press.data, message.message_id);
      return;
    }

    const message = update.message;
    if (!message?.text || String(message.chat.id) !== this.link.chatId) return;
    const text = message.text.trim();
    if (text === '/start') return;

    const repliedTo = message.reply_to_message?.message_id;
    const sendingBack = repliedTo !== undefined ? this.askingChanges.get(repliedTo) : undefined;
    if (sendingBack) {
      this.askingChanges.delete(repliedTo as number);
      const outcome = await this.options.onRequestChanges(sendingBack, text);
      await this.send(outcome.ok ? `↩️ Sent ${sendingBack} back with your note.` : outcome.message);
      return;
    }

    const command = text.toLowerCase().replace(/^\//, '');
    if (text.startsWith('/') && isRemoteCommand(command)) {
      await this.send(
        await this.options
          .onCommand(command)
          .catch((error: unknown) => `That didn’t work: ${errorMessage(error)}`),
      );
      return;
    }

    const taskId = repliedTo !== undefined ? this.about.get(repliedTo) : undefined;
    this.options.onMessage(taskId ? `About ${taskId}: ${text}` : text, { channel: 'telegram' });
  }

  private async onButton(data: string, messageId: number): Promise<void> {
    const [action, taskId] = data.split(':');
    if (!taskId || this.decided.has(messageId)) return;
    switch (action) {
      case 'approve':
        await this.api.setKeyboard(this.link.chatId, messageId, Buttons.confirm(taskId));
        return;
      case 'cancel':
        await this.api.setKeyboard(this.link.chatId, messageId, Buttons.review(taskId));
        return;
      case 'confirm': {
        this.decided.add(messageId);
        await this.api.setKeyboard(this.link.chatId, messageId);
        await this.settle(await this.options.onApprove(taskId), messageId);
        return;
      }
      case 'changes': {
        const prompt = await this.send(
          `What should change in ${taskId}? Reply to this message, and the next build works from your note.`,
          [],
          { forceReply: true, replyTo: messageId },
        );
        if (prompt !== undefined) remember(this.askingChanges, prompt, taskId);
        return;
      }
    }
  }

  /** Say what came of a button, under the notification it was on. */
  private async settle(outcome: Outcome, messageId: number): Promise<void> {
    await this.send(`${outcome.ok ? '✅' : '⚠️'} ${outcome.message}`, [], { replyTo: messageId });
  }
}

/** A notification in Telegram's words: plain text, with its screenshots sent after. */
export function telegramText(note: Notification): string {
  switch (note.kind) {
    case 'info':
      return note.text;
    case 'blocked':
      return [
        `❓ ${note.taskId} needs you: ${note.title}`,
        note.question,
        'Reply to this message with your answer, and I’ll pick it back up.',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'review':
      return [
        `✅ ${note.taskId} is ready for your review: ${note.title}`,
        note.summary,
        note.facts.join(' · '),
      ]
        .filter(Boolean)
        .join('\n\n');
  }
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  const oldest = map.keys().next().value;
  if (map.size > MAX_REMEMBERED && oldest !== undefined) map.delete(oldest);
}

function split(text: string): string[] {
  const parts: string[] = [];
  for (let rest = text; rest.length > 0; rest = rest.slice(MAX_LENGTH))
    parts.push(rest.slice(0, MAX_LENGTH));
  return parts;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
