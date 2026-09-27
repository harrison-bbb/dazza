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
import {
  blockTask,
  setSubtaskStatus,
  submitTask,
  takeNewMessages,
  WorkReport,
} from '../core/work.js';
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
  checkMessages: tool('check_messages'),
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
  McpTools.checkMessages,
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
  const outcome = await store.updatePlan(
    (current): [Plan | undefined, { error: string } | { count: number; rescoped: boolean }] => {
      const tasks = carryOverProgress(current, input.tasks);
      if (typeof tasks === 'string') return [undefined, { error: tasks }];
      const result = Plan.safeParse({ version: SCHEMA_VERSION, approvedAt: null, tasks });
      if (!result.success) {
        return [undefined, { error: `The plan is invalid:\n${z.prettifyError(result.error)}` }];
      }
      return [result.data, { count: tasks.length, rescoped: Boolean(current?.approvedAt) }];
    },
  );
  if ('error' in outcome) return failure(outcome.error);

  const tasks = `${outcome.count} tasks`;
  await store.writeScope(input.scope);
  await store.appendEvent({
    at: new Date().toISOString(),
    type: outcome.rescoped ? 'scope_change_proposed' : 'plan_created',
    message:
      input.summary ??
      `${outcome.rescoped ? 'Revised the approved plan' : 'Drafted a plan'}: ${tasks}`,
  });

  const text = outcome.rescoped
    ? `Saved ${tasks}. The plan needs the user's approval again.`
    : `Saved ${tasks}.`;
  return { content: [{ type: 'text', text }] };
}

export type McpRole = 'manager' | 'worker';

/**
 * Dazza's tools for an agent. The conversation (manager) plans and edits the
 * project; the builder (worker) reports progress and hands work over. Each
 * gets only its own tools.
 */
export function createMcpServer(store: Store, role: McpRole): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: pkg.version });
  if (role === 'manager') registerManagerTools(server, store);
  else registerWorkerTools(server, store);
  return server;
}

function registerManagerTools(server: McpServer, store: Store): void {
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
      description:
        "Post on a task or subtask's thread on the board. Use as: 'user' to pass on something " +
        'the user told you, e.g. an instruction for the task being built; the build picks it up ' +
        'at its next check-in. Otherwise it posts as Dazza.',
      inputSchema: {
        id: z.string(),
        body: z.string().min(1),
        as: z.enum(['dazza', 'user']).default('dazza'),
      },
    },
    async ({ id, body, as }) => toResult(await addComment(store, id, body, as)),
  );
}

function registerWorkerTools(server: McpServer, store: Store): void {
  // Every reply carries anything the user has said about the task since the
  // worker last checked, so comments reach it mid-build.
  const withNews = async (taskOrSubtaskId: string, result: ActionResult) => {
    const news = await takeNewMessages(store, taskOrSubtaskId.split('.')[0] ?? taskOrSubtaskId);
    return toResult(result, news);
  };

  server.registerTool(
    'check_messages',
    {
      description:
        'See if the user has said anything about your task since you last checked. Use it ' +
        'between steps when you have been working for a while without other Dazza tool calls.',
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => withNews(taskId, { ok: true, message: 'Checked.' }),
  );

  server.registerTool(
    'comment',
    {
      description:
        "Post a note on a task or subtask's thread, e.g. a decision the user would want to know.",
      inputSchema: { id: z.string(), body: z.string().min(1) },
    },
    async ({ id, body }) => withNews(id, await addComment(store, id, body, 'dazza')),
  );

  server.registerTool(
    'update_subtask',
    {
      description: 'Mark a subtask of the task you are building as started or finished.',
      inputSchema: { id: z.string(), status: z.enum(['building', 'closed']) },
    },
    async ({ id, status }) => withNews(id, await setSubtaskStatus(store, id, status)),
  );

  server.registerTool(
    'block',
    {
      description:
        'Stop and ask the user for something you cannot decide or get yourself: a decision, ' +
        'a credential, access, or permission. Ask one clear question. Then stop working.',
      inputSchema: { taskId: z.string(), question: z.string().min(1) },
    },
    async ({ taskId, question }) => withNews(taskId, await blockTask(store, taskId, question)),
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
}

/** Entry point for `dazza mcp`, spawned by the agent CLI over stdio. */
export async function serveMcp(projectRoot: string, role: McpRole): Promise<void> {
  await createMcpServer(new Store(projectRoot), role).connect(new StdioServerTransport());
}

function toResult(result: ActionResult, news: string[] = []): CallToolResult {
  const text = news.length
    ? `${result.message}\n\nNew from the user since you last checked. Follow it:\n${news.join('\n')}`
    : result.message;
  return result.ok ? { content: [{ type: 'text', text }] } : failure(text);
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
