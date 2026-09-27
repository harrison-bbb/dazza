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

/** What the user asked for, and what came of it. */
export interface Outcome {
  ok: boolean;
  message: string;
}

/** What a channel can ask of Dazza on the user's behalf. */
export interface ChannelHandlers {
  /** A message from the user, to answer like one typed in the terminal. */
  onMessage(text: string, from: Remote): void;
  onCommand(command: RemoteCommand): Promise<string>;
  onApprove(taskId: string): Promise<Outcome>;
  onRequestChanges(taskId: string, note: string): Promise<Outcome>;
  /** Something the user should know, e.g. another window has the connection. */
  onProblem(text: string): void;
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
