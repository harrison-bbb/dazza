import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { carryOverProgress } from '../core/plan.js';
import { Plan, SCHEMA_VERSION, Task } from '../core/schema.js';
import { Store } from '../core/store.js';

export const MCP_SERVER_NAME = 'dazza';

/** Fully-qualified tool names as agents see them, for allow-listing. */
export const McpTools = {
  savePlan: `mcp__${MCP_SERVER_NAME}__save_plan`,
} as const;

export const SavePlanInput = z.object({
  scope: z.string().min(1).describe('The scope of work as Markdown.'),
  tasks: z.array(Task).min(1).describe('Ordered tasks with acceptance criteria and subtasks.'),
});
export type SavePlanInput = z.infer<typeof SavePlanInput>;

/**
 * Validate and persist a plan. Revising an approved plan is a scope change: it
 * returns to draft for the user to re-approve. Problems are returned to the agent
 * as tool errors so it can correct the plan and try again.
 */
export async function savePlan(store: Store, input: SavePlanInput): Promise<CallToolResult> {
  const current = await store.readPlan();
  const tasks = carryOverProgress(current, input.tasks);
  if (typeof tasks === 'string') return failure(tasks);

  const result = Plan.safeParse({ version: SCHEMA_VERSION, approvedAt: null, tasks });
  if (!result.success) return failure(`The plan is invalid:\n${z.prettifyError(result.error)}`);

  const rescoped = Boolean(current?.approvedAt);
  await store.writeScope(input.scope);
  await store.writePlan(result.data);
  await store.appendEvent({
    at: new Date().toISOString(),
    type: rescoped ? 'scope_change_proposed' : 'plan_created',
    message: `${rescoped ? 'Revised the approved plan' : 'Drafted a plan'}: ${tasks.length} tasks`,
  });

  const count = `${tasks.length} tasks`;
  return {
    content: [
      {
        type: 'text',
        text: rescoped
          ? `Saved ${count}. The plan needs the user's approval again.`
          : `Saved ${count}.`,
      },
    ],
  };
}

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: pkg.version });

  server.registerTool(
    'save_plan',
    {
      description:
        'Save the scope of work and task breakdown for the user to review and approve. ' +
        'Call again with the full plan to revise it. Task status is managed by Dazza.',
      inputSchema: SavePlanInput.shape,
    },
    (input) => savePlan(store, input),
  );

  return server;
}

/** Entry point for `dazza mcp`, spawned by the agent CLI over stdio. */
export async function serveMcp(projectRoot: string): Promise<void> {
  await createMcpServer(new Store(projectRoot)).connect(new StdioServerTransport());
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
