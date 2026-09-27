import { type BuildEvent, build } from '../core/builder.js';
import type { Config } from '../core/config.js';
import { clock, explainAgentError } from '../core/errors.js';
import type { Manager } from '../core/manager.js';
import type { Store } from '../core/store.js';
import { McpTools } from '../mcp/server.js';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import { openInBrowser } from '../util/open.js';
import { createBuildRenderer } from './buildView.js';
import type { Usage } from './commands.js';
import { describeTool, planCard } from './describe.js';
import { paint, renderInline } from './style.js';

/** Where the session's output goes. The terminal in practice; a recorder in tests. */
export interface SessionOutput {
  /** Dazza speaking. */
  say(text: string): void;
  /** Raw lines, e.g. build progress. */
  print(text: string): void;
  /** Show or clear an activity in the status line. */
  status(key: 'chat' | 'build', text: string | undefined): void;
}

export interface SessionOptions {
  store: Store;
  config: Config;
  provider: AgentProvider;
  manager: Manager;
  /** How the builder's agent launches Dazza's worker tools. */
  workerMcp: McpServerConfig;
  boardUrl: string;
  output: SessionOutput;
  /** Called with every build event, e.g. to send notifications. */
  onBuildEvent?: (event: BuildEvent) => void;
  /** Called with Dazza's full reply to a message, e.g. to answer on Telegram. */
  onReply?: (reply: string, origin: MessageOrigin) => void;
  /** Called when Dazza shares screenshots in a comment, e.g. to send them to Telegram. */
  onShare?: (share: Share) => void;
}

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
export type MessageOrigin = 'terminal' | 'telegram';

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

  constructor(private readonly options: SessionOptions) {}

  get isBuilding(): boolean {
    return this.building !== undefined;
  }

  get isChatting(): boolean {
    return this.chat !== undefined;
  }

  /** Queue a message for Dazza; it's answered after any earlier ones. */
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
    const controller = new AbortController();
    this.building = { controller, done: this.runBuild(controller.signal) };
    return true;
  }

  /** Stop the build; the current task is paused and resumes next time. */
  async stopBuild(): Promise<void> {
    if (!this.building) return;
    this.options.output.status('build', 'Stopping');
    this.building.controller.abort();
    await this.building.done;
  }

  /** Stop answering: drop queued messages and cut off the current reply. */
  async stopChat(): Promise<void> {
    if (!this.chat) return;
    this.queue.length = 0;
    this.chat.controller.abort();
    await this.chat.done;
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
        await this.converse(message.text, message.origin, signal);
      }
    } finally {
      this.chat = undefined;
      this.options.output.status('chat', undefined);
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
    let rewrotePlan = false;
    output.status('chat', 'Thinking');

    try {
      for await (const event of manager.send(message, signal)) {
        this.countUsage(event);
        this.noticeShares(event);
        if (event.type === 'retry') output.status('chat', retryStatus(event));
        if (event.type === 'text') {
          reply.push(event.text);
          output.say(renderInline(event.text));
        } else if (event.type === 'tool_use') {
          rewrotePlan ||= event.tool === McpTools.savePlan;
          output.status('chat', describeTool(event.tool, event.input));
        } else if (event.type === 'finished' && !event.ok) {
          output.say(
            paint.red(
              event.error
                ? explainAgentError(event.error, { provider: this.options.provider.id })
                : event.output || 'Something went wrong on my end.',
            ),
          );
        }
      }
    } catch (error) {
      output.say(
        signal.aborted ? paint.dim('Stopped.') : paint.red(`Error: ${errorMessage(error)}`),
      );
    }
    if (reply.length > 0) onReply?.(reply.join('\n\n'), origin);

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
    try {
      for await (const event of build({ store, config, provider, mcpServer: workerMcp, signal })) {
        if (event.type === 'agent') {
          this.countUsage(event.event);
          this.noticeShares(event.event);
          if (event.event.type === 'retry') output.status('build', retryStatus(event.event));
        }
        if (event.type === 'task_started') output.status('build', `Building ${event.task.id}`);
        if (event.type === 'waiting' && event.reason === 'usage_limit') {
          output.status('build', `Waiting for your usage limit to reset (${clock(event.until)})`);
        }
        const text = render(event, await store.readPlan());
        if (text) output.print(text);
        onBuildEvent?.(event);
      }
    } catch (error) {
      output.say(paint.red(`Build stopped: ${errorMessage(error)}`));
    } finally {
      this.building = undefined;
      output.status('build', undefined);
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
      images.map((path) => `  ${paint.dim(`📸 ${boardUrl}/api/media/${path}`)}`).join('\n'),
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

function retryStatus(event: Extract<AgentEvent, { type: 'retry' }>): string {
  return `Anthropic didn’t answer; retrying (${event.attempt}/${event.maxRetries})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
