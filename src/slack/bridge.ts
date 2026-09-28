import { z } from 'zod';
import type { SlackLink } from '../core/config.js';
import {
  type Channel,
  type ChannelHandlers,
  isRemoteCommand,
  type Outcome,
  type Remote,
} from '../notify/channel.js';
import type { Notification } from '../notify/notification.js';
import { claim } from '../util/lock.js';
import { type Block, SlackApi } from './api.js';
import {
  Actions,
  CHANGES_MODAL,
  changesModal,
  fromSlackText,
  type HomeState,
  homeView,
  NOTE_INPUT,
  notificationMessage,
  replyMessages,
  resolved,
} from './blocks.js';
import { type Envelope, SocketMode, type SocketModeOptions } from './socket.js';

export interface SlackHandlers extends ChannelHandlers {
  onApprovePlan(): Promise<Outcome>;
  /** The project as the Home tab shows it. */
  home(): Promise<Omit<HomeState, 'online'>>;
}

export type SlackClient = Pick<
  SlackApi,
  'postMessage' | 'updateMessage' | 'react' | 'openView' | 'publishHome' | 'uploadFiles'
>;

export interface SlackBridgeOptions {
  /** Where this window claims the Slack connection (one window at a time). */
  lockFile: string;
  api?: SlackClient;
  /** Makes the Socket Mode connection; swapped out in tests. */
  socket?: (options: Omit<SocketModeOptions, 'open'>) => Pick<SocketMode, 'start' | 'stop'>;
}

/** Shown while Dazza works out an answer. */
const THINKING = 'eyes';
/** Left on a message once Dazza has answered it. */
const ANSWERED = 'white_check_mark';
/** Enough to find which task a thread is about, without growing forever. */
const MAX_THREADS = 200;

/** Where to answer a message: its conversation, and its thread if it was in one. */
const Ref = z.object({ channel: z.string(), ts: z.string(), thread: z.string().optional() });

/**
 * Dazza's Slack app, while Dazza is open: a DM for notifications and
 * conversation, buttons to approve or send back work, a Home tab showing the
 * project, and `/dazza`. Only the linked user is listened to.
 */
export class SlackBridge implements Channel {
  readonly id = 'slack';
  private readonly api: SlackClient;
  private socket: Pick<SocketMode, 'start' | 'stop'> | undefined;
  private release: (() => Promise<void>) | undefined;
  private starting: Promise<void> | undefined;
  /** Notification message ts → the task it's about, so thread replies carry context. */
  private readonly threads = new Map<string, string>();
  /** Review notifications' blocks, so a "Request changes" modal can update its message. */
  private readonly posted = new Map<string, Block[]>();
  /** Review notifications already approved or sent back. */
  private readonly decided = new Set<string>();
  private reportedFailure = false;

  constructor(
    private readonly link: SlackLink,
    private readonly handlers: SlackHandlers,
    private readonly options: SlackBridgeOptions,
  ) {
    this.api = options.api ?? new SlackApi(link.botToken);
  }

  /**
   * Connect, unless another Dazza window already has: Slack would share
   * events between the two at random. Sending works from every window.
   */
  start(): void {
    this.starting ??= this.connect();
  }

  async stop(): Promise<void> {
    await this.starting;
    await this.socket?.stop();
    if (this.release) {
      // The Home tab would otherwise offer buttons nothing is listening to.
      await this.publishHome(false);
      await this.release();
    }
    this.socket = undefined;
    this.release = undefined;
  }

  async notify(note: Notification): Promise<void> {
    await this.guard(async () => {
      const home = await this.handlers.home();
      const message = notificationMessage(note, home);
      const posted = await this.api.postMessage({ channel: this.link.channelId, ...message });
      const decides = note.kind === 'review' || note.kind === 'permission';
      this.remember(posted.ts, note.taskId, decides ? message.blocks : undefined);
      if (note.images.length > 0) {
        await this.api.uploadFiles(posted.channel, note.images, posted.ts);
      }
    });
    if (note.kind !== 'info') void this.publishHome(true);
  }

  async reply(text: string, to: Remote): Promise<void> {
    const ref = Ref.safeParse(safeJson(to.ref));
    const channel = ref.success ? ref.data.channel : this.link.channelId;
    await this.guard(async () => {
      for (const part of replyMessages(text)) {
        await this.api.postMessage({
          channel,
          ...part,
          ...(ref.success && ref.data.thread && { threadTs: ref.data.thread }),
        });
      }
    });
    if (ref.success) {
      await this.api.react(channel, ref.data.ts, THINKING, false).catch(() => {});
      // ✅ once answered; nothing if the answer was cut off, so it doesn't look handled.
      if (text) await this.api.react(channel, ref.data.ts, ANSWERED, true).catch(() => {});
    }
    void this.publishHome(true);
  }

  refresh(): void {
    void this.publishHome(true);
  }

  private async connect(): Promise<void> {
    this.release = await claim(this.options.lockFile);
    if (!this.release) {
      this.handlers.onProblem(
        'Another Dazza window is connected to Slack, so your Slack messages go there. ' +
          'Notifications from this one still arrive.',
      );
      return;
    }
    const socketOptions = {
      onEnvelope: (envelope: Envelope) => this.handle(envelope),
      onFatal: (error: Error) =>
        this.handlers.onProblem(
          `Couldn’t connect to Slack: ${error.message}. Run /slack-disconnect and link it again.`,
        ),
    };
    this.socket =
      this.options.socket?.(socketOptions) ??
      new SocketMode({
        ...socketOptions,
        open: () => new SlackApi(this.link.appToken).openConnection(),
      });
    this.socket.start();
    void this.publishHome(true);
  }

  /** A delivery from Slack. Answers within Slack's 3 seconds; slow work carries on after. */
  private handle(envelope: Envelope): unknown {
    switch (envelope.type) {
      case 'events_api': {
        const parsed = EventPayload.safeParse(envelope.payload);
        if (parsed.success) this.onEvent(parsed.data.event);
        return undefined;
      }
      case 'interactive':
        return this.onInteraction(envelope.payload);
      case 'slash_commands': {
        const parsed = SlashCommand.safeParse(envelope.payload);
        return parsed.success ? this.onSlashCommand(parsed.data) : undefined;
      }
      default:
        return undefined;
    }
  }

  private onEvent(event: SlackEvent): void {
    if (event.type === 'app_home_opened') {
      if (event.user === this.link.userId && event.tab === 'home') void this.publishHome(true);
      return;
    }
    // Only plain messages in a DM with the bot: not edits, joins, or its own posts.
    if (event.type !== 'message' || event.channel_type !== 'im') return;
    if (event.subtype || event.bot_id || !event.text || !event.user) return;
    if (event.user !== this.link.userId) {
      void this.guard(() =>
        this.api.postMessage({
          channel: event.channel,
          text: `Sorry, I only take instructions from <@${this.link.userId}>.`,
        }),
      );
      return;
    }

    const ref = JSON.stringify({
      channel: event.channel,
      ts: event.ts,
      ...(event.thread_ts && { thread: event.thread_ts }),
    });
    void this.api.react(event.channel, event.ts, THINKING, true).catch(() => {});
    const taskId = event.thread_ts ? this.threads.get(event.thread_ts) : undefined;
    const text = fromSlackText(event.text);
    this.handlers.onMessage(taskId ? `About ${taskId}: ${text}` : text, { channel: 'slack', ref });
  }

  private onInteraction(payload: unknown): unknown {
    const click = BlockActions.safeParse(payload);
    if (click.success) {
      const { user, actions, trigger_id } = click.data;
      const action = actions[0];
      if (!action || user.id !== this.link.userId) return undefined;
      const message = click.data.container.type === 'message' ? click.data : undefined;
      const where = message?.channel &&
        message.message && {
          channel: message.channel.id,
          ts: message.message.ts,
          blocks: message.message.blocks,
        };
      void this.onClick(action.action_id, action.value, trigger_id, where);
      return undefined;
    }

    const submission = ViewSubmission.safeParse(payload);
    if (submission.success && submission.data.view.callback_id === CHANGES_MODAL) {
      if (submission.data.user.id !== this.link.userId) return undefined;
      const note = submission.data.view.state.values[NOTE_INPUT]?.[NOTE_INPUT]?.value?.trim();
      if (!note) {
        return { response_action: 'errors', errors: { [NOTE_INPUT]: 'Say what needs to change.' } };
      }
      const meta = ChangesMeta.safeParse(safeJson(submission.data.view.private_metadata));
      if (meta.success) void this.sendBack(meta.data, note);
      return undefined;
    }
    return undefined;
  }

  private async onClick(
    actionId: string,
    value: string | undefined,
    triggerId: string,
    where: { channel: string; ts: string; blocks: Block[] } | undefined,
  ): Promise<void> {
    await this.guard(async () => {
      switch (actionId) {
        case Actions.approve: {
          if (!value) return;
          // From the Home tab, settle the DM notification's buttons too.
          where ??= this.reviewMessage(value);
          // A double tap would otherwise overwrite "approved" with "isn't in review".
          if (where && this.decided.has(where.ts)) return;
          if (where) this.decided.add(where.ts);
          const outcome = await this.handlers.onApprove(value);
          await this.settle(where, outcome.ok ? `✅ ${outcome.message}` : `⚠️ ${outcome.message}`);
          return;
        }
        case Actions.allowCommand:
        case Actions.refuseCommand: {
          if (!value || (where && this.decided.has(where.ts))) return;
          if (where) this.decided.add(where.ts);
          const allow = actionId === Actions.allowCommand;
          const outcome = await this.handlers.onPermission(value, allow);
          await this.settle(
            where,
            `${outcome.ok ? (allow ? '✅' : '🚫') : '⚠️'} ${outcome.message}`,
          );
          return;
        }
        case Actions.requestChanges: {
          if (!value) return;
          const meta = JSON.stringify({
            taskId: value,
            ...(where && { channel: where.channel, ts: where.ts }),
          });
          await this.api.openView(triggerId, changesModal(value, meta));
          return;
        }
        case Actions.approvePlan: {
          const outcome = await this.handlers.onApprovePlan();
          await this.say(
            outcome.ok
              ? `✅ ${outcome.message} Start building from the Home tab, or \`/dazza build\`.`
              : outcome.message,
          );
          return;
        }
        case Actions.build:
        case Actions.stop:
          await this.say(await this.handlers.onCommand(actionId));
          return;
        default:
          // Link buttons (the board) report clicks too; the link does the work.
          return;
      }
    });
    await this.publishHome(true);
  }

  private async sendBack(meta: ChangesMeta, note: string): Promise<void> {
    await this.guard(async () => {
      const outcome = await this.handlers.onRequestChanges(meta.taskId, note);
      const blocks = meta.ts && this.posted.get(meta.ts);
      const where =
        meta.channel && meta.ts && blocks
          ? { channel: meta.channel, ts: meta.ts, blocks }
          : this.reviewMessage(meta.taskId);
      if (where) this.decided.add(where.ts);
      await this.settle(where, outcome.ok ? `↩️ Sent back: “${note}”` : `⚠️ ${outcome.message}`);
    });
    await this.publishHome(true);
  }

  /** The latest review notification for a task, if this window posted one. */
  private reviewMessage(
    taskId: string,
  ): { channel: string; ts: string; blocks: Block[] } | undefined {
    const ts = [...this.threads]
      .reverse()
      .find(([ts, id]) => id === taskId && this.posted.has(ts))?.[0];
    const blocks = ts && this.posted.get(ts);
    return ts && blocks ? { channel: this.link.channelId, ts, blocks } : undefined;
  }

  /**
   * Show what came of a button: on the message it was on, in place of its
   * buttons, or as a message of its own when it came from the Home tab.
   */
  private async settle(
    where: { channel: string; ts: string; blocks: Block[] } | undefined,
    line: string,
  ): Promise<void> {
    if (where && where.blocks.length > 0) {
      await this.api.updateMessage(where.channel, where.ts, line, resolved(where.blocks, line));
    } else {
      await this.say(line);
    }
  }

  private onSlashCommand(command: SlashCommand): unknown {
    if (command.user_id !== this.link.userId) {
      return { text: `Dazza works for <@${this.link.userId}>, so it only takes their commands.` };
    }
    const name = command.text.trim().toLowerCase();
    if (!isRemoteCommand(name)) {
      return {
        text: '`/dazza status` shows where the project is at, `/dazza build` starts building, `/dazza stop` stops. To talk to me, message me directly.',
      };
    }
    void this.handlers
      .onCommand(name)
      .then((text) => this.respond(command.response_url, text))
      .catch(() => {});
    return undefined;
  }

  /** Answer a slash command where it was typed, visible only to the user. */
  private async respond(url: string, text: string): Promise<void> {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
    void this.publishHome(true);
  }

  private async say(text: string): Promise<void> {
    for (const part of replyMessages(text)) {
      await this.api.postMessage({ channel: this.link.channelId, ...part });
    }
  }

  private async publishHome(online: boolean): Promise<void> {
    if (!this.release) return; // Another window owns the Home tab.
    try {
      const state = await this.handlers.home();
      await this.api.publishHome(this.link.userId, homeView({ ...state, online }));
    } catch {
      // The Home tab is a nicety; the DM carries everything that matters.
    }
  }

  private remember(ts: string, taskId: string | undefined, blocks?: Block[]): void {
    if (taskId) this.threads.set(ts, taskId);
    if (blocks) this.posted.set(ts, blocks);
    for (const map of [this.threads, this.posted]) {
      const oldest = map.keys().next().value;
      if (map.size > MAX_THREADS && oldest !== undefined) map.delete(oldest);
    }
  }

  /** Run a Slack call, reporting failures to the terminal (once per outage) instead of throwing. */
  private async guard(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
      this.reportedFailure = false; // working again: report the next outage too
    } catch (error) {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        this.handlers.onProblem(`Couldn’t reach Slack: ${errorMessage(error)}`);
      }
    }
  }
}

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SlackEvent = z.looseObject({
  type: z.string(),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string().default(''),
  channel_type: z.string().optional(),
  ts: z.string().default(''),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  tab: z.string().optional(),
});
type SlackEvent = z.infer<typeof SlackEvent>;

const EventPayload = z.looseObject({ event: SlackEvent });

const BlockActions = z.looseObject({
  type: z.literal('block_actions'),
  user: z.looseObject({ id: z.string() }),
  trigger_id: z.string(),
  container: z.looseObject({ type: z.string() }),
  channel: z.looseObject({ id: z.string() }).optional(),
  message: z
    .looseObject({ ts: z.string(), blocks: z.array(z.record(z.string(), z.unknown())).default([]) })
    .optional(),
  actions: z.array(z.looseObject({ action_id: z.string(), value: z.string().optional() })),
});

const ViewSubmission = z.looseObject({
  type: z.literal('view_submission'),
  user: z.looseObject({ id: z.string() }),
  view: z.looseObject({
    callback_id: z.string(),
    private_metadata: z.string().default(''),
    state: z.looseObject({
      values: z.record(
        z.string(),
        z.record(z.string(), z.looseObject({ value: z.string().nullish() })),
      ),
    }),
  }),
});

const ChangesMeta = z.object({
  taskId: z.string(),
  channel: z.string().optional(),
  ts: z.string().optional(),
});
type ChangesMeta = z.infer<typeof ChangesMeta>;

const SlashCommand = z.looseObject({
  user_id: z.string(),
  text: z.string().default(''),
  response_url: z.string(),
});
type SlashCommand = z.infer<typeof SlashCommand>;
