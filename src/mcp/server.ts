import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { type ActionResult, addComment, REQUESTABLE_STATUSES, setStatus } from '../core/actions.js';
import {
  addSubtask,
  addTask,
  editSubtask,
  editTask,
  NewTask,
  type SubtaskChanges,
  TaskChanges,
} from '../core/edits.js';
import { carryOverProgress } from '../core/plan.js';
import { Plan, SCHEMA_VERSION, Task } from '../core/schema.js';
import { Store } from '../core/store.js';
import { blockTask, setSubtaskStatus, submitTask, WorkReport } from '../core/work.js';
import { Git } from '../git/git.js';

export const MCP_SERVER_NAME = 'dazza';

/** Fully-qualified tool names as agents see them, for allow-listing. */
export const McpTools = {
  savePlan: tool('save_plan'),
  updateItem: tool('update_item'),
  addTask: tool('add_task'),
  addSubtask: tool('add_subtask'),
  setStatus: tool('set_status'),
  comment: tool('comment'),
  updateSubtask: tool('update_subtask'),
  block: tool('block'),
  submit: tool('submit'),
} as const;

/** Tools for the conversation: planning, and changing the project when the user asks. */
export const MANAGER_TOOLS = [
  McpTools.savePlan,
  McpTools.updateItem,
  McpTools.addTask,
  McpTools.addSubtask,
  McpTools.setStatus,
  McpTools.comment,
];

/** Tools for building a task: report progress, ask the user, hand work over. */
export const WORKER_TOOLS = [
  McpTools.updateSubtask,
  McpTools.comment,
  McpTools.block,
  McpTools.submit,
];

function tool(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const SavePlanInput = z.object({
  scope: z.string().min(1).describe('The scope of work as Markdown.'),
  tasks: z.array(Task).min(1).describe('Ordered tasks with acceptance criteria and subtasks.'),
  summary: z
    .string()
    .optional()
    .describe('When revising, one line on what changed and why. Shown in the scope history.'),
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
    message:
      input.summary ??
      `${rescoped ? 'Revised the approved plan' : 'Drafted a plan'}: ${tasks.length} tasks`,
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
        'Call again with the full plan to revise it. New tasks and subtasks are `planned` by ' +
        'default; set `backlog` for agreed nice-to-haves that should wait. After that, status ' +
        'is managed by Dazza.',
      inputSchema: SavePlanInput.shape,
    },
    (input) => savePlan(store, input),
  );

  // Direct edits the user asks for in conversation. These apply immediately and
  // don't need re-approval, because the user asked for them.
  server.registerTool(
    'update_item',
    {
      description:
        'Change a task or subtask the user asked you to change. Subtasks only have a title ' +
        'and description. Pass only the fields that change.',
      inputSchema: { id: z.string(), ...TaskChanges.shape },
    },
    async ({ id, ...changes }) =>
      toResult(
        id.includes('.')
          ? await editSubtask(store, id, pickSubtaskChanges(changes))
          : await editTask(store, id, changes),
      ),
  );

  server.registerTool(
    'add_task',
    {
      description: 'Add a new task the user asked for. It gets the next task id.',
      inputSchema: NewTask.shape,
    },
    async (input) => toResult(await addTask(store, input)),
  );

  server.registerTool(
    'add_subtask',
    {
      description: "Add a subtask to an existing task at the user's request.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ taskId, title, description }) =>
      toResult(await addSubtask(store, taskId, { title, ...(description && { description }) })),
  );

  server.registerTool(
    'set_status',
    {
      description:
        'Move a task where the user asked: closed (accept reviewed work), cancelled (drop it), ' +
        'planned (queue it, unblock it, or send reviewed work back, which needs a note), or ' +
        'backlog (defer it). Only do this when the user asked.',
      inputSchema: {
        id: z.string(),
        status: z.enum(REQUESTABLE_STATUSES),
        note: z.string().optional().describe('Why, or what to change. Saved as their comment.'),
      },
    },
    async ({ id, status, note }) => toResult(await setStatus(store, id, status, note)),
  );

  server.registerTool(
    'comment',
    {
      description: "Post a comment from Dazza on a task or subtask's thread on the board.",
      inputSchema: { id: z.string(), body: z.string().min(1) },
    },
    async ({ id, body }) => toResult(await addComment(store, id, body, 'dazza')),
  );

  // While building a task.
  server.registerTool(
    'update_subtask',
    {
      description: 'Mark a subtask of the task you are building as started or finished.',
      inputSchema: { id: z.string(), status: z.enum(['building', 'closed']) },
    },
    async ({ id, status }) => toResult(await setSubtaskStatus(store, id, status)),
  );

  server.registerTool(
    'block',
    {
      description:
        'Stop and ask the user for something you cannot decide or get yourself: a decision, ' +
        'a credential, access, or permission. Ask one clear question. Then stop working.',
      inputSchema: { taskId: z.string(), question: z.string().min(1) },
    },
    async ({ taskId, question }) => toResult(await blockTask(store, taskId, question)),
  );

  server.registerTool(
    'submit',
    {
      description:
        'Hand the finished task to the user for review. Dazza commits your changes. ' +
        'Only call this once the acceptance criteria are met and the checks pass.',
      inputSchema: { taskId: z.string(), ...WorkReport.shape },
    },
    async ({ taskId, ...report }) =>
      toResult(await submitTask(store, new Git(store.root), taskId, report)),
  );

  return server;
}

/** Entry point for `dazza mcp`, spawned by the agent CLI over stdio. */
export async function serveMcp(projectRoot: string): Promise<void> {
  await createMcpServer(new Store(projectRoot)).connect(new StdioServerTransport());
}

function toResult(result: ActionResult): CallToolResult {
  return result.ok
    ? { content: [{ type: 'text', text: result.message }] }
    : failure(result.message);
}

function pickSubtaskChanges(changes: TaskChanges): SubtaskChanges {
  return {
    ...(changes.title && { title: changes.title }),
    ...(changes.description && { description: changes.description }),
  };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
