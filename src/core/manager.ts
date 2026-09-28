import { MANAGER_TOOLS, MCP_SERVER_NAME } from '../mcp/server.js';
import type { ChannelId } from '../notify/channel.js';
import managerPrompt from '../prompts/manager.md';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import type { Activity } from './activity.js';
import type { Config } from './config.js';
import { humanDuration, minutesLeft, sizeMinutes } from './estimates.js';
import { milestoneProgress } from './milestones.js';
import { progress } from './plan.js';
import type { Event, Plan } from './schema.js';
import type { Store } from './store.js';
import { trackUsage } from './usage.js';

/**
 * Read-only tools to inspect the codebase, plus Dazza's own tools to plan and to
 * change the project when the user asks. No tools that edit code.
 */
const TOOLS = ['Read', 'Glob', 'Grep', ...MANAGER_TOOLS];

export interface ManagerOptions {
  store: Store;
  config: Config;
  provider: AgentProvider;
  projectRoot: string;
  /** How the agent CLI should launch Dazza's MCP server. */
  mcpServer: McpServerConfig;
  /** Checks every tool call the manager makes; see src/guard. */
  guard?: McpServerConfig;
  /** The code already in the directory, in a few words, if any. */
  codebase?: string;
}

/**
 * The user-facing conversation. Every message resumes the same agent session and
 * carries a fresh snapshot of project state, because things change between messages
 * (slash commands, the board, the work loop) that the conversation never saw.
 */
export class Manager {
  constructor(private readonly options: ManagerOptions) {}

  /** `from`: the messaging app the user wrote from, if not the terminal. */
  async *send(message: string, signal?: AbortSignal, from?: ChannelId): AsyncGenerator<AgentEvent> {
    const { store, provider } = this.options;
    const sessionId = await store.readManagerSession(provider.id);
    if (!sessionId) {
      yield* this.run(message, undefined, signal, from);
      return;
    }

    // Agent CLIs delete old conversations (Claude Code after 30 days). A resume
    // that fails before it starts means that, so start a fresh one instead.
    let started = false;
    for await (const event of this.run(message, sessionId, signal, from)) {
      if (event.type === 'started') started = true;
      const gone =
        !started &&
        event.type === 'finished' &&
        !event.ok &&
        (event.error?.kind ?? 'failed') === 'failed';
      if (!gone) {
        yield event;
        continue;
      }
      await store.clearManagerSession();
      yield {
        type: 'text',
        text: 'I couldn’t pick up our earlier conversation, so I’ve started a fresh one. The plan and the board are just as they were.',
      };
      yield* this.run(message, undefined, signal, from);
      return;
    }
  }

  private async *run(
    message: string,
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    from: ChannelId | undefined,
  ): AsyncGenerator<AgentEvent> {
    const { store, config, provider, projectRoot, mcpServer } = this.options;
    const { model } = await config.readSettings();
    const plan = await store.readPlan();
    // What the builders are doing right now, so "how's it going?" gets a real answer.
    const activity: Record<string, Activity[]> = {};
    for (const task of plan?.tasks.filter((t) => t.status === 'building') ?? []) {
      activity[task.id] = await store.readActivity(task.id, RECENT_ACTIVITY);
    }
    const state = [
      describeState(plan, await store.readEvents(), this.options.codebase, activity),
      // Away from the terminal, they haven't seen its greeting or build output.
      from &&
        `The user is writing from ${CHANNEL_NAMES[from]}, on their phone, not the terminal. Keep the reply short.`,
    ]
      .filter(Boolean)
      .join('\n');
    const events = provider.run({
      prompt: `<project-state>\n${state}\n</project-state>\n\n${message}`,
      cwd: projectRoot,
      systemPrompt: managerPrompt,
      allowedTools: TOOLS,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      ...(this.options.guard && { guard: this.options.guard }),
      ...(sessionId && { resumeSessionId: sessionId }),
      ...(model && { model }),
      ...(signal && { signal }),
    });

    for await (const event of events) {
      // Only a conversation that's really underway is worth resuming; a failed
      // run's id (or none at all) would break the next message.
      const id =
        event.type === 'started' || (event.type === 'finished' && event.ok)
          ? event.sessionId
          : undefined;
      if (id) await store.writeManagerSession(id, provider.id);
      await trackUsage(store, config, event);
      yield event;
    }
  }
}

const RECENT_COMMENTS = 10;
const CHANNEL_NAMES: Record<ChannelId, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  desktop: 'a desktop notification',
};
/** Enough of a builder's latest steps to say how it's going. */
const RECENT_ACTIVITY = 12;

/** A compact snapshot of the plan, plus the latest comments from the board. */
export function describeState(
  plan: Plan | undefined,
  events: Event[] = [],
  codebase?: string,
  activity: Record<string, Activity[]> = {},
): string {
  const where = codebase
    ? `Working directory: ${codebase}.`
    : 'Working directory: empty, a new project.';
  if (!plan) return `${where}\nNo plan yet.`;

  const { closed, total } = progress(plan);
  const status = plan.approvedAt
    ? `approved, ${closed}/${total} tasks closed`
    : 'draft, awaiting approval';
  const milestoneOf = new Map(plan.milestones.flatMap((m) => m.tasks.map((id) => [id, m.id])));
  const left = minutesLeft(plan, events);
  const sizes = sizeMinutes(plan, events);
  const lines = [
    where,
    `Task sizes on this project, in building time: S about ${sizes.S} minutes, M about ${sizes.M}, L about ${sizes.L}.`,
    `Plan (${status}), tasks in priority order${left ? `, ${humanDuration(left)} of building left` : ''}:`,
    ...plan.tasks.map(
      (t) =>
        `- ${t.id} [${t.status}${t.size ? `, ${t.size}` : ''}${milestoneOf.has(t.id) ? `, ${milestoneOf.get(t.id)}` : ''}] ${t.title}`,
    ),
    ...(plan.milestones.length > 0
      ? [
          'Milestones:',
          ...milestoneProgress(plan).map(
            ({ milestone, closed, total, reached }) =>
              `- ${milestone.id} ${milestone.title} (${reached ? 'reached' : `${closed}/${total} closed`}): ${milestone.goal}`,
          ),
        ]
      : []),
  ];

  const comments = events.filter((e) => e.type === 'comment').slice(-RECENT_COMMENTS);
  if (comments.length > 0) {
    lines.push('', 'Recent comments on the board:');
    lines.push(
      ...comments.map((c) => `- ${c.taskId ?? 'general'} · ${c.actor} (${c.at}): ${c.message}`),
    );
  }
  for (const [taskId, steps] of Object.entries(activity)) {
    const task = plan.tasks.find((t) => t.id === taskId);
    const live = task?.subtasks.filter((st) => st.status !== 'cancelled') ?? [];
    const done = live.filter((st) => st.status === 'closed').length;
    lines.push(
      '',
      `What ${taskId}'s builder is doing (${done} of ${live.length} subtasks done; latest step last):`,
      ...steps.map((step) => `- ${ago(step.at)}: ${step.text}`),
    );
  }
  // The user's own edits to the scope: read it again before talking about it.
  const edits = events.filter((e) => e.type === 'scope_changed' && e.actor === 'user').slice(-3);
  if (edits.length > 0) {
    lines.push(
      '',
      'The user edited the scope on the board (read .dazza/scope.md for the current version):',
      ...edits.map((e) => `- ${e.at}: ${e.message}`),
    );
  }
  return lines.join('\n');
}

/** "just now", "4m ago": the user's clock may not be UTC. */
function ago(at: string): string {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 1 ? 'just now' : `${minutes}m ago`;
}
