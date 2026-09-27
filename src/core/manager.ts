import { MCP_SERVER_NAME, McpTools } from '../mcp/server.js';
import managerPrompt from '../prompts/manager.md';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import { progress } from './plan.js';
import type { Plan } from './schema.js';
import type { Store } from './store.js';

/** Read-only tools let the manager inspect an existing codebase while scoping. */
const MANAGER_TOOLS = ['Read', 'Glob', 'Grep', McpTools.savePlan];

export interface ManagerOptions {
  store: Store;
  provider: AgentProvider;
  projectRoot: string;
  /** How the agent CLI should launch Dazza's MCP server. */
  mcpServer: McpServerConfig;
}

/**
 * The user-facing conversation. Every message resumes the same agent session and
 * carries a fresh snapshot of project state, because things change between messages
 * (slash commands, the board, the work loop) that the conversation never saw.
 */
export class Manager {
  constructor(private readonly options: ManagerOptions) {}

  async *send(message: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { store, provider, projectRoot, mcpServer } = this.options;
    const sessionId = await store.readManagerSession();

    const state = describeState(await store.readPlan());
    const events = provider.run({
      prompt: `<project-state>\n${state}\n</project-state>\n\n${message}`,
      cwd: projectRoot,
      systemPrompt: managerPrompt,
      allowedTools: MANAGER_TOOLS,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      ...(sessionId && { resumeSessionId: sessionId }),
      ...(signal && { signal }),
    });

    for await (const event of events) {
      if (event.type === 'started' || event.type === 'finished') {
        await store.writeManagerSession(event.sessionId);
      }
      yield event;
    }
  }
}

/** A compact snapshot of the plan for the agent's system prompt. */
export function describeState(plan: Plan | undefined): string {
  if (!plan) return '## Project state\n\nNo plan yet.';

  const { done, total } = progress(plan);
  const status = plan.approvedAt
    ? `approved, ${done}/${total} tasks done`
    : 'draft, awaiting approval';
  const tasks = plan.tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`);
  return [`## Project state`, '', `Plan (${status}):`, ...tasks].join('\n');
}
