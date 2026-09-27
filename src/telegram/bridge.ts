import { setTimeout as sleep } from 'node:timers/promises';
import type { BuildEvent } from '../core/builder.js';
import type { TelegramLink } from '../core/config.js';
import type { Store } from '../core/store.js';
import { TelegramApi, TelegramError } from './api.js';

const POLL_SECONDS = 25;
const RETRY_MS = 5_000;
/** Telegram's limit is 4096 characters per message. */
const MAX_LENGTH = 4000;

export interface BridgeOptions {
  /** A message from the user's own chat. */
  onMessage(text: string): void;
  /** Something the user should know, e.g. another Dazza window is reading the bot. */
  onProblem(text: string): void;
  api?: Pick<TelegramApi, 'getUpdates' | 'sendMessage' | 'sendPhoto'>;
}

/**
 * Dazza's line to the user's phone while it's open: sends notifications and
 * replies, and passes on messages from the user's own chat (and no one else's).
 */
export class TelegramBridge {
  private readonly api: Pick<TelegramApi, 'getUpdates' | 'sendMessage' | 'sendPhoto'>;
  private readonly controller = new AbortController();
  private polling: Promise<void> | undefined;
  private reportedSendFailure = false;

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

  /**
   * Send a message, then any screenshots with it. Failures are reported once,
   * not thrown: Telegram is a side channel.
   */
  async send(text: string, images: string[] = []): Promise<void> {
    try {
      for (const part of split(text)) await this.api.sendMessage(this.link.chatId, part);
      for (const image of images) await this.api.sendPhoto(this.link.chatId, image);
    } catch (error) {
      if (!this.reportedSendFailure) {
        this.reportedSendFailure = true;
        this.options.onProblem(`Couldn’t send to Telegram: ${errorMessage(error)}`);
      }
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
          const message = update.message;
          if (!message?.text || String(message.chat.id) !== this.link.chatId) continue;
          if (message.text.trim() === '/start') continue;
          this.options.onMessage(message.text);
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
}

/** A message for the user's phone, with screenshot files to send after it. */
export interface Notification {
  text: string;
  images: string[];
}

/** What to tell the user on Telegram about a build event, if anything. */
export async function notificationFor(
  event: BuildEvent,
  store: Store,
): Promise<Notification | undefined> {
  if (event.type === 'stopped') return { text: `Build finished. ${event.reason}`, images: [] };
  if (event.type !== 'task_finished' || event.outcome === 'paused') return undefined;

  const plan = await store.readPlan();
  const task = plan?.tasks.find((t) => t.id === event.task.id) ?? event.task;

  if (event.outcome === 'blocked') {
    const question = (await store.readEvents())
      .filter((e) => e.type === 'comment' && e.actor === 'dazza' && e.taskId === task.id)
      .at(-1);
    return {
      text: [
        `❓ ${task.id} needs you: ${task.title}`,
        question?.message,
        'Reply here with your answer, and I’ll pick it back up next build.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      images: (question?.images ?? []).map((path) => store.mediaFile(path)),
    };
  }

  const handoff = task.handoff;
  const checks = handoff?.checks ?? [];
  const failing = checks.filter((c) => !c.passed).length;
  const facts = [
    handoff?.filesChanged !== undefined &&
      `${handoff.filesChanged} ${handoff.filesChanged === 1 ? 'file' : 'files'} changed`,
    checks.length > 0 &&
      (failing
        ? `${failing} failing ${failing === 1 ? 'check' : 'checks'}`
        : `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`),
  ].filter(Boolean);
  return {
    text: [
      `✅ ${task.id} is ready for your review: ${task.title}`,
      handoff?.summary,
      facts.join(' · '),
      `Reply "close ${task.id}" to approve it, or tell me what to change.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    images: (handoff?.screenshots ?? []).map((path) => store.mediaFile(path)),
  };
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
