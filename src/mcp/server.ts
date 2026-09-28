import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import {
  type ActionResult,
  addComment,
  approvePlan,
  prioritise,
  REQUESTABLE_STATUSES,
  setStatus,
} from '../core/actions.js';
import {
  addSubtask,
  addTask,
  editSubtask,
  editTask,
  NewTask,
  type SubtaskChanges,
  TaskChanges,
} from '../core/edits.js';
import { answerPermission, requestPermission } from '../core/permissions.js';
import { carryOverProgress } from '../core/plan.js';
import { REPORT_SECTIONS } from '../core/report.js';
import { missingSections, reviewPlan } from '../core/review.js';
import { MediaPath, Milestone, Plan, SCHEMA_VERSION, Task } from '../core/schema.js';
import { changeLogEntries, keepChangeLog, withChangeLog } from '../core/scope.js';
import { Store } from '../core/store.js';
import {
  blockTask,
  setSubtaskStatus,
  submitTask,
  takeNewMessages,
  WorkReport,
} from '../core/work.js';
import { judge } from '../guard/policy.js';
import { ScreenshotRequest, Screenshots } from '../preview/screenshots.js';

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
  askPermission: tool('ask_permission'),
  updateScope: tool('update_scope'),
  approvePlan: tool('approve_plan'),
  prioritise: tool('prioritise'),
  writeReport: tool('write_report'),
  answerPermission: tool('answer_permission'),
  screenshot: tool('screenshot'),
} as const;

/** Tools for the conversation: planning, and changing the project when the user asks. */
export const MANAGER_TOOLS = [
  McpTools.savePlan,
  McpTools.updateItem,
  McpTools.addTask,
  McpTools.addSubtask,
  McpTools.setStatus,
  McpTools.comment,
  McpTools.answerPermission,
  McpTools.updateScope,
  McpTools.approvePlan,
  McpTools.prioritise,
  McpTools.writeReport,
  McpTools.screenshot,
];

/** Tools for building a task: report progress, ask the user, hand work over. */
export const WORKER_TOOLS = [
  McpTools.updateSubtask,
  McpTools.comment,
  McpTools.checkMessages,
  McpTools.block,
  McpTools.askPermission,
  McpTools.submit,
  McpTools.screenshot,
];

function tool(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const SavePlanInput = z.object({
  scope: z.string().min(1).describe('The scope of work as Markdown.'),
  tasks: z
    .array(Task)
    .min(1)
    .describe('Tasks in priority order, each with a size, acceptance criteria and subtasks.'),
  milestones: z
    .array(Milestone)
    .default([])
    .describe('Stages the user can try, in order, each a few tasks with a goal.'),
  summary: z
    .string()
    .optional()
    .describe('When revising an approved plan, one line on what changed. Goes in the change log.'),
  why: z
    .string()
    .optional()
    .describe('When revising an approved plan, why, as the user put it. Goes in the change log.'),
});
export type SavePlanInput = z.input<typeof SavePlanInput>;

/**
 * Validate and persist a plan. Revising an approved plan is a scope change: it
 * returns to draft for the user to re-approve. Problems are returned to the agent
 * as tool errors so it can correct the plan and try again.
 */
export async function savePlan(store: Store, raw: SavePlanInput): Promise<CallToolResult> {
  const input = SavePlanInput.parse(raw);
  const problems = reviewPlan(input.scope, input.tasks, input.milestones);
  if (problems.length > 0) {
    return failure(
      `Not saved. The builder works from the plan alone, and it's missing detail:\n${problems
        .map((p) => `- ${p}`)
        .join('\n')}\nFix these and call save_plan again with the whole plan.`,
    );
  }
  const outcome = await store.updatePlan(
    (current): [Plan | undefined, { error: string } | { count: number; rescoped: boolean }] => {
      const tasks = carryOverProgress(current, input.tasks);
      if (typeof tasks === 'string') return [undefined, { error: tasks }];
      const result = Plan.safeParse({
        version: SCHEMA_VERSION,
        approvedAt: null,
        tasks,
        milestones: input.milestones,
      });
      if (!result.success) {
        return [undefined, { error: `The plan is invalid:\n${z.prettifyError(result.error)}` }];
      }
      return [result.data, { count: tasks.length, rescoped: Boolean(current?.approvedAt) }];
    },
  );
  if ('error' in outcome) return failure(outcome.error);

  const tasks = `${outcome.count} tasks`;
  const previous = await store.readScope();
  await store.writeScope(
    // Rewriting an approved plan is a change to what was agreed: it goes in the log.
    outcome.rescoped
      ? withChangeLog(
          input.scope,
          previous,
          {
            summary: input.summary ?? 'Revised the whole plan',
            why: input.why ?? 'agreed in conversation',
            tasks: [],
          },
          new Date(),
        )
      : keepChangeLog(input.scope, previous),
  );
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
export function createMcpServer(
  store: Store,
  role: McpRole,
  screenshots: Pick<Screenshots, 'take'> = new Screenshots(store, appRoot(store, role)),
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: pkg.version });
  if (role === 'manager') registerManagerTools(server, store);
  else registerWorkerTools(server, store);
  // The builder's screenshots belong to the task it's building unless it says otherwise.
  const defaultTask = async () =>
    role === 'worker'
      ? (await store.readPlan())?.tasks.find((t) => t.status === 'building')?.id
      : undefined;
  registerScreenshotTool(server, screenshots, defaultTask, (path) => store.mediaFile(path));
  return server;
}

/**
 * Where the app to screenshot lives: for the builder, the worktree of the task
 * it's building, so it sees its own work; otherwise the user's checkout.
 */
function appRoot(store: Store, role: McpRole): () => Promise<string> {
  return async () => {
    if (role !== 'worker') return store.root;
    const building = (await store.readPlan())?.tasks.find((t) => t.status === 'building');
    return (building && (await store.readTaskBuild(building.id))?.dir) ?? store.root;
  };
}

/** Both roles can look at the app; what they do with the picture differs. */
function registerScreenshotTool(
  server: McpServer,
  screenshots: Pick<Screenshots, 'take'>,
  defaultTask: () => Promise<string | undefined>,
  /** Where a screenshot is on disk, so the agent can look at it. */
  mediaFile: (path: string) => string,
): void {
  server.registerTool(
    'screenshot',
    {
      description:
        'Take a screenshot of the project’s app, to show the user something visual. Dazza starts the ' +
        'app if needed. It returns a path to attach with the screenshots field of comment, block or ' +
        'submit. Only take one when it adds real context: the user asked for it, you want their ' +
        'opinion on UI, you finished UI work, or you found a visual problem.',
      inputSchema: ScreenshotRequest.shape,
    },
    async (request) => {
      try {
        const taskId = request.taskId ?? (await defaultTask());
        const shot = await screenshots.take({ ...request, ...(taskId && { taskId }) });
        return toResult({
          ok: true,
          message:
            `Saved ${shot.path} (${shot.width}×${shot.height}). To look at it yourself, Read ${mediaFile(shot.path)}. ` +
            `To show the user, attach it with screenshots: ["${shot.path}"].`,
        });
      } catch (error) {
        return failure(
          `Couldn’t take the screenshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

const Attachments = z
  .array(MediaPath)
  .default([])
  .describe('Screenshots to show with it, from the screenshot tool.');

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
    'write_report',
    {
      description:
        'Save the close-out (or progress) report for the user: Markdown with the sections you ' +
        'were asked for. It replaces any earlier report and shows on the board.',
      inputSchema: { markdown: z.string().min(1) },
    },
    async ({ markdown }) => {
      const missing = REPORT_SECTIONS.filter(
        (section) => !new RegExp(`^##\\s+${section}\\s*$`, 'mi').test(markdown),
      );
      if (missing.length > 0) {
        return failure(`Not saved: add ${missing.map((s) => `## ${s}`).join(', ')}.`);
      }
      await store.writeReport(markdown);
      await store.appendEvent({
        at: new Date().toISOString(),
        type: 'report_written',
        message: 'Wrote the report',
      });
      return toResult({ ok: true, message: 'Saved. It’s on the board under Report.' });
    },
  );

  server.registerTool(
    'prioritise',
    {
      description:
        'Change what gets built next when the user asks ("do T7 next", "T4 is urgent"): move ' +
        'a task to the front of the queue, or ahead of another. Tasks still wait for what ' +
        'they depend on.',
      inputSchema: {
        id: z.string(),
        before: z.string().optional().describe('Put it just ahead of this task instead.'),
      },
    },
    async ({ id, before }) => toResult(await prioritise(store, id, before)),
  );

  server.registerTool(
    'approve_plan',
    {
      description:
        'Approve the drafted plan, which lets building start. Only when the user has clearly ' +
        'said to approve it, having seen the plan (or the change to it) in this conversation.',
      inputSchema: {},
    },
    async () => toResult(await approvePlan(store)),
  );

  server.registerTool(
    'update_scope',
    {
      description:
        'Rewrite the scope document after the user agrees a change to what is being built, so ' +
        'it always matches the plan: new or dropped features, a changed decision, anything the ' +
        'builder should now do differently. Pass the full updated scope; Dazza keeps the change ' +
        'log itself and adds this change to it. Make the task changes with the task tools too.',
      inputSchema: {
        scope: z.string().min(1).describe('The whole scope, updated. Leave out the change log.'),
        summary: z.string().min(1).describe('What changed, in one line.'),
        why: z.string().min(1).describe('Why, as the user put it.'),
        tasks: z.array(z.string()).default([]).describe('Tasks added, changed or cancelled.'),
      },
    },
    async ({ scope, summary, why, tasks }) => {
      const missing = missingSections(scope);
      if (missing.length > 0) {
        return failure(
          `Not saved: the scope is missing ${missing.map((s) => `## ${s}`).join(', ')}. Pass the whole scope.`,
        );
      }
      const plan = await store.readPlan();
      const previous = await store.readScope();
      // Before approval the plan is still a draft: nothing agreed yet to log changes against.
      const updated = plan?.approvedAt
        ? withChangeLog(scope, previous, { summary, why, tasks }, new Date())
        : keepChangeLog(scope, previous);
      await store.writeScope(updated);
      await store.appendEvent({
        at: new Date().toISOString(),
        type: 'scope_changed',
        message: `${summary}${tasks.length ? ` (${tasks.join(', ')})` : ''}`,
      });
      const version = changeLogEntries(updated).length + 1;
      return toResult({
        ok: true,
        message: plan?.approvedAt
          ? `Scope updated to v${version}, with the change logged.`
          : 'Scope updated.',
      });
    },
  );

  server.registerTool(
    'answer_permission',
    {
      description:
        'Record the user’s answer when a task is waiting for their OK to run a command. ' +
        'allow: true only when they clearly said yes. Either way the task goes back in the queue.',
      inputSchema: {
        taskId: z.string(),
        allow: z.boolean(),
        note: z.string().optional().describe('Anything else they said, passed to the build.'),
      },
    },
    async ({ taskId, allow, note }) => toResult(await answerPermission(store, taskId, allow, note)),
  );

  server.registerTool(
    'comment',
    {
      description:
        "Post on a task or subtask's thread on the board, or on the project when there's no id. " +
        "Use as: 'user' to pass on something the user told you, e.g. an instruction for the task " +
        'being built; the build picks it up at its next check-in. Otherwise it posts as Dazza. ' +
        'To send the user a screenshot, attach it here: it reaches them on the board, and on Slack or Telegram if linked.',
      inputSchema: {
        id: z.string().optional(),
        body: z.string().min(1),
        as: z.enum(['dazza', 'user']).default('dazza'),
        screenshots: Attachments,
      },
    },
    async ({ id, body, as, screenshots }) =>
      toResult(await addComment(store, id, body, { actor: as, images: screenshots })),
  );
}

function registerWorkerTools(server: McpServer, store: Store): void {
  // Every reply carries anything the user has said about the task since the
  // worker last checked, so comments reach it mid-build.
  const withNews = async (taskOrSubtaskId: string, result: ActionResult) => {
    const news = await takeNewMessages(store, taskOrSubtaskId.split('.')[0] ?? taskOrSubtaskId);
    return toResult(result, news);
  };
  // The builder works on one task: its tools reach that task and its subtasks, nothing else.
  const ownTask = async (
    id: string,
    act: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    const building = (await store.readPlan())?.tasks.find((t) => t.status === 'building');
    const taskId = id.split('.')[0];
    if (!building) return failure('No task is being built right now.');
    if (taskId !== building.id) {
      return failure(
        `You're building ${building.id}; ${id} isn't part of it. Leave other tasks alone, and mention anything about them in a comment on ${building.id}.`,
      );
    }
    return act();
  };

  server.registerTool(
    'check_messages',
    {
      description:
        'See if the user has said anything about your task since you last checked. Use it ' +
        'between steps when you have been working for a while without other Dazza tool calls.',
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) =>
      ownTask(taskId, () => withNews(taskId, { ok: true, message: 'Checked.' })),
  );

  server.registerTool(
    'comment',
    {
      description:
        "Post a note on a task or subtask's thread, e.g. a decision the user would want to know, " +
        'or a screenshot of a visual problem you found. Screenshots reach the user on Slack or Telegram too, if linked.',
      inputSchema: { id: z.string(), body: z.string().min(1), screenshots: Attachments },
    },
    async ({ id, body, screenshots }) =>
      ownTask(id, async () =>
        withNews(id, await addComment(store, id, body, { actor: 'dazza', images: screenshots })),
      ),
  );

  server.registerTool(
    'update_subtask',
    {
      description: 'Mark a subtask of the task you are building as started or finished.',
      inputSchema: { id: z.string(), status: z.enum(['building', 'closed']) },
    },
    async ({ id, status }) =>
      ownTask(id, async () => withNews(id, await setSubtaskStatus(store, id, status))),
  );

  server.registerTool(
    'block',
    {
      description:
        'Stop and ask the user for something you cannot decide or get yourself: a decision, ' +
        'a credential, access, or permission, or their opinion on UI you built (attach a ' +
        'screenshot). Ask one clear question. Then stop working.',
      inputSchema: { taskId: z.string(), question: z.string().min(1), screenshots: Attachments },
    },
    async ({ taskId, question, screenshots }) =>
      ownTask(taskId, async () =>
        withNews(taskId, await blockTask(store, taskId, question, { images: screenshots })),
      ),
  );

  server.registerTool(
    'ask_permission',
    {
      description:
        "Ask the user to allow one exact command that Dazza's guard held back for their OK. " +
        'Only when the task truly needs it and there is no safer way. Then stop: the task ' +
        'waits for their answer.',
      inputSchema: {
        taskId: z.string(),
        command: z.string().min(1).describe('The exact command, as you will run it.'),
        why: z.string().min(1).describe('Why the task needs it, and what it changes.'),
      },
    },
    async ({ taskId, command, why }) =>
      ownTask(taskId, async () => {
        const decision = judge({ tool: 'Bash', input: { command } }, { workspace: store.root });
        if (decision.kind === 'never') {
          return failure(`That can’t be allowed, even with the user’s OK: ${decision.reason}`);
        }
        return toResult(await requestPermission(store, taskId, command, why));
      }),
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
      ownTask(taskId, async () => toResult(await submitTask(store, taskId, report))),
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
