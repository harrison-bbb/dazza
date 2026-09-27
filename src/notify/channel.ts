import type { Notification } from './notification.js';

export type ChannelId = 'telegram' | 'slack';

/**
 * A message that came in from a channel. `ref` is the channel's own note of
 * where to answer, e.g. a Slack thread; only that channel reads it.
 */
export interface Remote {
  channel: ChannelId;
  ref?: string;
}

/** Commands that work from a phone as well as the terminal. */
export const REMOTE_COMMANDS = ['status', 'build', 'stop'] as const;
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export function isRemoteCommand(text: string): text is RemoteCommand {
  return (REMOTE_COMMANDS as readonly string[]).includes(text);
}

/** Somewhere Dazza reaches the user while they're away from the terminal. */
export interface Channel {
  readonly id: ChannelId;
  /** Start taking the user's messages. */
  start(): void;
  stop(): Promise<void>;
  /** Tell the user something. Failures are reported, not thrown: channels are a side line. */
  notify(note: Notification): Promise<void>;
  /** Answer a message the user sent through this channel. Empty means there was no answer. */
  reply(text: string, to: Remote): Promise<void>;
  /** The project changed, e.g. a build started: update anything showing it. */
  refresh(): void;
}
