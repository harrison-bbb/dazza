import { boardLink } from '../board/link.js';
import { ActivityRecorder } from '../core/activity.js';
import { type BuildEvent, build } from '../core/builder.js';
import type { Config } from '../core/config.js';
import { clock, explainAgentError } from '../core/errors.js';
import type { Manager } from '../core/manager.js';
import { nextTask } from '../core/plan.js';
import type { Store } from '../core/store.js';
import { McpTools } from '../mcp/server.js';
import type { Remote } from '../notify/channel.js';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import { openInBrowser } from '../util/open.js';
import { errorMessage } from '../util/text.js';
import { BRAND } from './banner.js';
import { compactedLine, createBuildRenderer, createStepTracker } from './buildView.js';
import type { Usage } from './commands.js';
import { describeTool, planCard } from './describe.js';
import { describeShellRuns, type ShellRun } from './shell.js';
import { paint, renderInline, stripAnsi } from './style.js';

/** Where the session's output goes. The terminal in practice; a recorder in tests. */
export interface SessionOutput {
  /** Dazza speaking. */
  say(text: string): void;
  /** Raw lines, e.g. build progress. */
  print(text: string): void;
  /** Show or clear an activity in the status line. */
  status(key: 'chat' | 'build', text: string | undefined): void;
  /** Show (or clear) the unfinished line of a reply as it streams in. */
  draft?(text: string | undefined): void;
}

export interface SessionOptions {
  store: Store;
  config: Config;
  provider: AgentProvider;
  manager: Manager;
  /** How the builder's agent launches Dazza's worker tools. */
  workerMcp: McpServerConfig;
  /** How the builder's agent runs Dazza's guard before each tool call. */
  workerGuard?: McpServerConfig;
  boardUrl: string;
  output: SessionOutput;
  /** Called with every build event, e.g. to send notifications. */
  onBuildEvent?: (event: BuildEvent) => void;
  /** Called once a build has finished, however it ended. */
  onBuildEnd?: () => void;
  /** The user asked Dazza, in conversation, to start building. */
  onStartBuild?: () => void;
  /** Dazza has answered everything it was sent, and is waiting for the next message. */
  onChatDone?: () => void;
  /**
   * Called with Dazza's full answer to every message, e.g. to answer on Slack.
   * Empty if there was none (the reply was stopped, say).
   */
  onReply?: (reply: string, origin: MessageOrigin) => void;
  /** Called when Dazza shares screenshots in a comment, e.g. to send them to Slack. */
  onShare?: (share: Share) => void;
}

/** "Dazza:", in front of a reply that arrives amid a build's output. */
function replyLabel(): string {
  return `${paint.hex(BRAND, paint.bold('Dazza:'))} `;
}

/**
 * A reply streaming in: each finished line goes on screen for good, formatted
 * as a whole reply would be (● and an indent), and the line still being
 * written shows live just above the status line until it's done.
 */
class StreamedText {
  started = false;
  label = '';
  private text = '';
  private printed = 0;
  private lines = 0;

  constructor(private readonly output: SessionOutput) {}

  write(piece: string): void {
    this.started = true;
    this.text += piece;
    const pending = this.text.slice(this.printed);
    const end = pending.lastIndexOf('\n');
    if (end >= 0) {
      for (const line of pending.slice(0, end).split('\n')) this.printLine(line);
      this.printed += end + 1;
    }
    const rest = this.text.slice(this.printed);
    this.output.draft?.(rest ? this.format(rest) : undefined);
  }

  /** The message is complete: its last line, then a blank line, as a whole reply ends. */
  end(): void {
    const rest = this.text.slice(this.printed);
    if (rest) this.printLine(rest);
    this.output.draft?.(undefined);
    this.output.print('');
    this.started = false;
    this.label = '';
    this.text = '';
    this.printed = 0;
    this.lines = 0;
  }

  private printLine(line: string): void {
    // A reply opens with a blank line and its marker, like everything Dazza says.
    this.output.print(this.lines === 0 ? `\n${this.format(line)}` : this.format(line));
    this.lines++;
  }

  private format(line: string): string {
    if (this.lines === 0) return `${paint.hex(BRAND, '●')} ${this.label}${renderInline(line)}`;
    return line ? `  ${renderInline(line)}` : '';
  }
}

/** How full the conversation gets before Dazza suggests /compact. */
const CONTEXT_NUDGE = 0.7;

/** Screenshots Dazza posted in a comment, with what it said about them. */
export interface Share {
  taskId?: string;
  text: string;
  /** Media paths, e.g. "T3/home-desktop.png". */
  images: string[];
}

/** Tools that can carry screenshots, and where their caption lives. */
const SHARING_TOOLS: Record<string, string> = {
  [McpTools.comment]: 'body',
  [McpTools.block]: 'question',
  [McpTools.submit]: 'summary',
};

/** Where a message came from, so the reply can go back the same way. */
export type MessageOrigin = 'terminal' | Remote;

/**
 * Everything running behind the prompt: the conversation with Dazza and the
 * build. They run side by side, so the user can talk to Dazza while it builds.
 * Messages are answered one at a time, in the order they were sent.
 */
export class ChatSession {
  readonly usage: Usage = { runs: 0, tokens: 0, costUsd: 0 };
  private readonly queue: { text: string; origin: MessageOrigin }[] = [];
  /** Tool calls that may share screenshots, waiting for their result. */
  private readonly pendingShares = new Map<
    string,
    { tool: string; input: Record<string, unknown> }
  >();
  private chat: { controller: AbortController; done: Promise<void> } | undefined;
  private building: { controller: AbortController; done: Promise<void> } | undefined;
  /**
   * The user wants the plan built: they started a build, and haven't stopped it
   * and it hasn't hit a problem. A build that ran out of ready work picks up
   * again by itself when something is ready (see `resumeIfReady`).
   */
  private keepBuilding = false;
  /** `!` commands since Dazza last heard from the user. */
  private readonly shellRuns: ShellRun[] = [];
  private contextTokens: number | undefined;
  /** Told the user it's getting full, for this conversation. */
  private nudged = false;
  /** Most models hold 200k tokens; the 1M-context ones say so in their name. */
  private contextWindow = 200_000;
  /** Tasks being built right now. */
  private readonly inProgress = new Set<string>();

  constructor(private readonly options: SessionOptions) {}

  get isBuilding(): boolean {
    return this.building !== undefined;
  }

  /** Building now, or will pick the build back up by itself when something's ready. */
  get isOnTheJob(): boolean {
    return this.keepBuilding || this.building !== undefined;
  }

  /** How full the conversation is, as of Dazza's last reply: tokens, and the model's window. */
  get context(): { tokens?: number; window: number } {
    return {
      ...(this.contextTokens !== undefined && { tokens: this.contextTokens }),
      window: this.contextWindow,
    };
  }

  /** Forget the size: a different conversation, or a compacted one, until the next reply measures it. */
  resetContext(tokens?: number): void {
    this.contextTokens = tokens;
    this.nudged = false;
  }

  get isChatting(): boolean {
    return this.chat !== undefined;
  }

  /** Queue a message for Dazza; it's answered after any earlier ones. */
  /** Remember a `!` command the user ran, to tell Dazza with their next message. */
  noteShell(run: ShellRun): void {
    this.shellRuns.push(run);
  }

  send(message: string, origin: MessageOrigin = 'terminal'): void {
    this.queue.push({ text: message, origin });
    if (!this.chat) {
      const controller = new AbortController();
      this.chat = { controller, done: this.drain(controller.signal) };
    }
  }

  /** Start building in the background. Returns false if a build is already running. */
  startBuild(): boolean {
    if (this.building) return false;
    this.keepBuilding = true;
    const controller = new AbortController();
    this.building = { controller, done: this.runBuild(controller.signal) };
    return true;
  }

  /** Stop the build; the current task is paused and resumes next time. */
  /** Stop the build. Resolves whether a task was underway (its pause is already reported). */
  async stopBuild(): Promise<boolean> {
    this.keepBuilding = false;
    if (!this.building) return false;
    const underway = this.inProgress.size > 0;
    this.options.output.status('build', 'Stopping');
    this.building.controller.abort();
    await this.building.done;
    return underway;
  }

  /**
   * Start building again if the user wants the plan built, nothing is running,
   * and a task is ready, e.g. once they've answered a blocked task. Resolves the
   * task picked up, if any.
   */
  async resumeIfReady(): Promise<string | undefined> {
    if (!this.keepBuilding || this.building) return undefined;
    const plan = await this.options.store.readPlan();
    const task = plan?.approvedAt ? nextTask(plan) : undefined;
    if (!task) return undefined;
    this.startBuild();
    return task.id;
  }

  /** Stop answering: drop queued messages and cut off the current reply. */
  async stopChat(): Promise<void> {
    if (!this.chat) return;
    this.queue.length = 0;
    this.chat.controller.abort();
    await this.chat.done;
  }

  /** `/compact`: summarise the conversation to free up room. Says how it went. */
  async compact(): Promise<string> {
    if (this.chat) return 'I’m still replying. Try /compact once I’ve answered.';
    this.options.output.status('chat', 'Compacting our conversation');
    try {
      const result = await this.options.manager.compact();
      if (!result) return 'Nothing to compact yet: we haven’t talked in this project.';
      this.resetContext(result.after);
      return `${stripAnsi(compactedLine(result, 'our conversation')).trim().replace(/^• /, '')}. The plan and the board are as they were.`;
    } catch (error) {
      return `Couldn’t compact: ${errorMessage(error)}`;
    } finally {
      this.options.output.status('chat', undefined);
    }
  }

  /** Wait until nothing is running, e.g. before exiting when input was piped in. */
  async idle(): Promise<void> {
    while (this.chat || this.building) await Promise.all([this.chat?.done, this.building?.done]);
  }

  private async drain(signal: AbortSignal): Promise<void> {
    try {
      for (
        let message = this.queue.shift();
        message !== undefined && !signal.aborted;
        message = this.queue.shift()
      ) {
        try {
          await this.converse(message.text, message.origin, signal);
        } catch (error) {
          // One failed message (e.g. a damaged .dazza file) mustn't stop the chat.
          const text = `Something went wrong: ${errorMessage(error)}`;
          this.options.output.say(paint.red(text));
          this.options.onReply?.(text, message.origin);
        }
      }
    } finally {
      this.chat = undefined;
      this.options.output.status('chat', undefined);
      this.options.onChatDone?.();
    }
  }

  private async converse(
    message: string,
    origin: MessageOrigin,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, manager, boardUrl, output, onReply } = this.options;
    const before = await store.readPlan();
    const reply: string[] = [];
    let startBuild = false;
    /** What went wrong, for a user who isn't watching the terminal. */
    let failure: string | undefined;
    let rewrotePlan = false;
    /** save_plan calls awaiting their result, and whether one was just sent back. */
    const saves = new Set<string>();
    let fixingPlan = false;
    /** The rejected plan was saved as a draft, and is being fixed item by item. */
    let fixingDraft = false;
    /** What Dazza reads, looks up and changes, shown as it goes, like Claude Code does. */
    const steps = createStepTracker();
    // In grey, so its own look-ups don't read like a builder's work.
    const showStep = (line: string | undefined) => {
      if (line && !fixingPlan) output.print(paint.dim(stripAnsi(line)));
    };
    /** A reply arriving in pieces, shown line by line as Claude Code does. */
    const stream = new StreamedText(output);
    output.status('chat', 'Thinking');

    // The chat's tools check this before merging (see Store.writeTurnOrigin).
    await store.writeTurnOrigin(origin === 'terminal' ? undefined : origin.channel);
    try {
      // Commands the user ran themselves go along as context.
      const ran = this.shellRuns.splice(0);
      for await (const event of manager.send(
        ran.length > 0 ? `${describeShellRuns(ran)}\n\n${message}` : message,
        signal,
        origin === 'terminal' ? undefined : origin.channel,
      )) {
        this.countUsage(event);
        this.noticeShares(event);
        if (event.type === 'tool_use' || event.type === 'tool_result') {
          showStep(steps.step(event, undefined, store.root));
        }
        if (event.type === 'started')
          this.contextWindow = /1m/i.test(event.model) ? 1_000_000 : 200_000;
        if (event.type === 'context') this.contextTokens = event.tokens;
        // It ran out of room and summarised itself, as Claude Code does.
        if (event.type === 'compacted') showStep(compactedLine(event, 'our conversation'));
        if (event.type === 'retry')
          output.status('chat', retryStatus(event, this.options.provider.name));
        if (event.type === 'text_delta') {
          if (fixingPlan) continue;
          if (!stream.started) {
            output.status('chat', 'Writing');
            showStep(steps.flush());
            stream.label = this.isBuilding && reply.length === 0 ? replyLabel() : '';
          }
          stream.write(event.text);
        } else if (event.type === 'text') {
          // Between a plan sent back for more detail and its resubmission, the
          // agent is fixing its own work: the user doesn't need to hear about it.
          if (fixingPlan) continue;
          reply.push(event.text);
          // Streamed already, as it was written: just finish it off.
          if (stream.started) {
            stream.end();
            continue;
          }
          // Amid a build's output, a reply needs a name on it to be seen.
          const label = this.isBuilding && reply.length === 1 ? replyLabel() : '';
          showStep(steps.flush());
          output.say(label + renderInline(event.text));
        } else if (event.type === 'tool_use') {
          rewrotePlan ||= event.tool === McpTools.savePlan;
          if (event.tool === McpTools.savePlan) {
            saves.add(event.id);
            fixingPlan = false;
          }
          startBuild ||= event.tool === McpTools.startBuild;
          output.status('chat', describeTool(event.tool, event.input));
        } else if (event.type === 'tool_result' && saves.delete(event.id)) {
          fixingPlan = !event.ok;
          fixingDraft = fixingPlan && ((await store.readPlan())?.problems.length ?? 0) > 0;
        } else if (event.type === 'tool_result' && fixingDraft) {
          // A draft the check sent back is being fixed item by item: quiet until it passes.
          fixingDraft = ((await store.readPlan())?.problems.length ?? 0) > 0;
          fixingPlan = fixingDraft;
        } else if (event.type === 'finished' && !event.ok) {
          const method = (await this.options.config.readConnection())?.method;
          failure = event.error
            ? explainAgentError(event.error, {
                provider: this.options.provider.id,
                ...(method && { method }),
              })
            : event.output || 'Something went wrong on my end.';
          output.say(paint.red(failure));
        }
      }
    } catch (error) {
      // Stopped (or failed) mid-sentence: keep what was written, then say why.
      if (stream.started) stream.end();
      if (!signal.aborted) failure = `Error: ${errorMessage(error)}`;
      output.say(signal.aborted ? paint.dim('Stopped.') : paint.red(failure ?? ''));
    }
    if (stream.started) stream.end();
    await store.writeTurnOrigin(undefined).catch(() => undefined);
    onReply?.(reply.length > 0 ? reply.join('\n\n') : (failure ?? ''), origin);
    // Past most of its room: say so once, as Claude Code does.
    const full = (this.contextTokens ?? 0) / this.contextWindow;
    if (full >= CONTEXT_NUDGE && !this.nudged) {
      this.nudged = true;
      output.print(
        paint.dim(`  Our conversation is ${Math.round(full * 100)}% full. /compact frees up room.`),
      );
    }
    if (startBuild && !signal.aborted) this.options.onStartBuild?.();

    // Small edits are confirmed in Dazza's own reply; a rewritten plan gets the full card.
    const after = await store.readPlan();
    if (rewrotePlan && after && JSON.stringify(after) !== JSON.stringify(before)) {
      output.print(`${planCard(after, Boolean(before?.approvedAt), boardUrl)}\n`);
      // The first plan is the moment to show the board; after that the tab is already open.
      if (!before) openInBrowser(boardUrl);
    }
  }

  private async runBuild(signal: AbortSignal): Promise<void> {
    const { store, config, provider, workerMcp, output, onBuildEvent } = this.options;
    const render = createBuildRenderer(store.root);
    output.status('build', 'Getting ready to build');
    const building = this.inProgress;
    building.clear();
    // What each builder does, for the board's live view.
    const activity = new ActivityRecorder(store);
    try {
      const { workerGuard } = this.options;
      for await (const event of build({
        store,
        config,
        provider,
        mcpServer: workerMcp,
        ...(workerGuard && { guard: workerGuard }),
        signal,
      })) {
        if (event.type === 'agent') {
          this.countUsage(event.event);
          this.noticeShares(event.event);
          if (event.event.type === 'retry')
            output.status('build', retryStatus(event.event, this.options.provider.name));
        }
        await activity.record(event);
        if (event.type === 'task_started') building.add(event.task.id);
        if (event.type === 'task_finished') building.delete(event.task.id);
        if (event.type === 'task_started' || event.type === 'task_finished') {
          output.status(
            'build',
            building.size ? `Building ${[...building].join(' and ')}` : 'Looking for the next task',
          );
        }
        if (event.type === 'waiting' && event.reason === 'usage_limit') {
          output.status('build', `Waiting for your usage limit to reset (${clock(event.until)})`);
        }
        const text = render(event, await store.readPlan());
        if (text) output.print(text);
        // A problem (no credit, a sign-in to fix) needs the user before building again.
        if (event.type === 'stopped' && !event.idle) this.keepBuilding = false;
        onBuildEvent?.(event);
      }
    } catch (error) {
      this.keepBuilding = false;
      output.say(paint.red(`Build stopped: ${errorMessage(error)}`));
    } finally {
      this.building = undefined;
      output.status('build', undefined);
      this.options.onBuildEnd?.();
    }
  }

  /**
   * Show links to screenshots once the call sharing them succeeds. Comments are
   * also passed on (e.g. to Telegram); questions and handoffs are sent there
   * with their own notifications.
   */
  private noticeShares(event: AgentEvent): void {
    if (event.type === 'tool_use' && event.tool in SHARING_TOOLS && isRecord(event.input)) {
      this.pendingShares.set(event.id, { tool: event.tool, input: event.input });
      return;
    }
    if (event.type !== 'tool_result') return;
    const call = this.pendingShares.get(event.id);
    this.pendingShares.delete(event.id);
    const images = stringList(call?.input.screenshots);
    if (!call || !event.ok || images.length === 0) return;

    const { boardUrl, output, onShare } = this.options;
    output.print(
      images
        .map((path) => `  ${paint.dim(`📸 ${boardLink(boardUrl, `/api/media/${path}`)}`)}`)
        .join('\n'),
    );
    if (call.tool === McpTools.comment) {
      const taskId = typeof call.input.id === 'string' ? call.input.id : undefined;
      const text = String(call.input[SHARING_TOOLS[call.tool] ?? 'body'] ?? '');
      onShare?.({ text, images, ...(taskId && { taskId }) });
    }
  }

  private countUsage(event: AgentEvent): void {
    if (event.type === 'finished' && event.usage) {
      this.usage.runs++;
      this.usage.tokens += event.usage.tokens;
      this.usage.costUsd += event.usage.costUsd;
    }
  }
}

function retryStatus(event: Extract<AgentEvent, { type: 'retry' }>, provider: string): string {
  return `No answer from ${provider}; retrying (${event.attempt}/${event.maxRetries})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
