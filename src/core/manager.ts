import { MANAGER_TOOLS, MCP_SERVER_NAME } from '../mcp/server.js';
import managerPrompt from '../prompts/manager.md';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import type { Config } from './config.js';
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

  async *send(message: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { store, config, provider, projectRoot, mcpServer } = this.options;
    const sessionId = await store.readManagerSession();
    const { model } = await config.readSettings();

    const state = describeState(
      await store.readPlan(),
      await store.readEvents(),
      this.options.codebase,
    );
    const events = provider.run({
      prompt: `<project-state>\n${state}\n</project-state>\n\n${message}`,
      cwd: projectRoot,
      systemPrompt: managerPrompt,
      allowedTools: TOOLS,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      ...(sessionId && { resumeSessionId: sessionId }),
      ...(model && { model }),
      ...(signal && { signal }),
    });

    for await (const event of events) {
      if (event.type === 'started' || event.type === 'finished') {
        await store.writeManagerSession(event.sessionId);
      }
      await trackUsage(store, config, event);
      yield event;
    }
  }
}

const RECENT_COMMENTS = 10;

/** A compact snapshot of the plan, plus the latest comments from the board. */
export function describeState(
  plan: Plan | undefined,
  events: Event[] = [],
  codebase?: string,
): string {
  const where = codebase
    ? `Working directory: ${codebase}.`
    : 'Working directory: empty, a new project.';
  if (!plan) return `${where}\nNo plan yet.`;

  const { closed, total } = progress(plan);
  const status = plan.approvedAt
    ? `approved, ${closed}/${total} tasks closed`
    : 'draft, awaiting approval';
  const lines = [
    where,
    `Plan (${status}):`,
    ...plan.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`),
  ];

  const comments = events.filter((e) => e.type === 'comment').slice(-RECENT_COMMENTS);
  if (comments.length > 0) {
    lines.push('', 'Recent comments on the board:');
    lines.push(
      ...comments.map((c) => `- ${c.taskId ?? 'general'} · ${c.actor} (${c.at}): ${c.message}`),
    );
  }
  return lines.join('\n');
}
