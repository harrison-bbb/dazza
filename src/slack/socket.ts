import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { SlackError } from './api.js';

/** One delivery from Slack: an event, a click, or a slash command. */
export const Envelope = z.looseObject({
  type: z.string(),
  envelope_id: z.string().optional(),
  payload: z.unknown().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/** The parts of a WebSocket we use, so tests can stand one in. */
export interface SocketLike {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SocketModeOptions {
  /** A fresh connection URL (apps.connections.open). */
  open(): Promise<string>;
  /**
   * Handle a delivery. Must return quickly: Slack wants an acknowledgement
   * within 3 seconds. The return value, if any, is sent back with it (e.g. a
   * modal's validation errors); slow work should carry on in the background.
   */
  onEnvelope(envelope: Envelope): unknown;
  /** The connection can't be made and retrying won't help, e.g. a revoked token. */
  onFatal(error: SlackError): void;
  connect?: (url: string) => SocketLike;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Errors that mean the app-level token or app setup is wrong, so retrying won't help. */
const FATAL = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'not_allowed_token_type',
  'missing_scope',
  'account_inactive',
]);

/**
 * A Socket Mode connection: Slack pushes events over a WebSocket we open, so
 * Dazza needs no public URL. Reconnects when Slack asks it to (it does,
 * every few hours) or the network drops, with backoff.
 */
export class SocketMode {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private socket: SocketLike | undefined;

  constructor(private readonly options: SocketModeOptions) {}

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.socket?.close();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      try {
        const url = await this.options.open();
        if (signal.aborted) return;
        if (await this.session(url)) backoff = MIN_BACKOFF_MS;
      } catch (error) {
        if (error instanceof SlackError && FATAL.has(error.code)) {
          this.options.onFatal(error);
          return;
        }
      }
      if (signal.aborted) return;
      await sleep(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** One connection, until it closes. Resolves whether Slack said hello. */
  private session(url: string): Promise<boolean> {
    const connect: (url: string) => SocketLike = this.options.connect ?? ((u) => new WebSocket(u));
    return new Promise((resolve) => {
      const socket = connect(url);
      this.socket = socket;
      let greeted = false;
      socket.addEventListener('message', ({ data }) => {
        const parsed = Envelope.safeParse(safeJson(String(data)));
        if (!parsed.success) return;
        const envelope = parsed.data;
        if (envelope.type === 'hello') greeted = true;
        // Slack is about to drop this connection; make the next one now.
        if (envelope.type === 'disconnect') socket.close();
        if (!envelope.envelope_id) return;
        let response: unknown;
        try {
          response = this.options.onEnvelope(envelope);
        } catch {
          // A bad delivery mustn't take the connection down; still acknowledge it.
        }
        socket.send(
          JSON.stringify({
            envelope_id: envelope.envelope_id,
            ...(response !== undefined && { payload: response }),
          }),
        );
      });
      socket.addEventListener('close', () => {
        this.socket = undefined;
        resolve(greeted);
      });
      socket.addEventListener('error', () => socket.close());
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
