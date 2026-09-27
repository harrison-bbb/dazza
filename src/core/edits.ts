import { z } from 'zod';
import type { ActionResult } from './actions.js';
import { findItem } from './plan.js';
import { type EventType, Plan, type Subtask, type Task } from './schema.js';
import type { Store } from './store.js';

/**
 * Changes to what the work *is*, made at the user's request (usually by asking
 * Dazza in the terminal). They apply immediately: the user asked for them, so
 * they don't need approving again. Status changes live in actions.ts.
 */

export const TaskChanges = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(),
  dependsOn: z.array(z.string()).optional(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

export const SubtaskChanges = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type SubtaskChanges = z.infer<typeof SubtaskChanges>;

export const NewTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  subtasks: z
    .array(z.object({ title: z.string().min(1), description: z.string().default('') }))
    .default([]),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(['planned', 'backlog']).default('planned'),
});
export type NewTask = z.input<typeof NewTask>;

export async function editTask(
  store: Store,
  id: string,
  changes: TaskChanges,
  now = new Date(),
): Promise<ActionResult> {
  return update(store, now, async (plan) => {
    const found = findItem(plan, id);
    if (!found || found.subtask) return `No task ${id}.`;
    const fields = definedKeys(changes);
    if (fields.length === 0) return 'Nothing to change.';
    return {
      plan: replaceTask(plan, { ...found.task, ...pickDefined(changes) }),
      event: { type: 'task_edited', taskId: id, message: `Edited ${fields.join(', ')}` },
    };
  });
}

export async function editSubtask(
  store: Store,
  id: string,
  changes: SubtaskChanges,
  now = new Date(),
): Promise<ActionResult> {
  return update(store, now, async (plan) => {
    const found = findItem(plan, id);
    if (!found?.subtask) return `No subtask ${id}.`;
    const fields = definedKeys(changes);
    if (fields.length === 0) return 'Nothing to change.';
    const subtask: Subtask = { ...found.subtask, ...pickDefined(changes) };
    const task = {
      ...found.task,
      subtasks: found.task.subtasks.map((s) => (s.id === id ? subtask : s)),
    };
    return {
      plan: replaceTask(plan, task),
      event: { type: 'task_edited', taskId: id, message: `Edited ${fields.join(', ')}` },
    };
  });
}

/** Add a task at the end of the plan, numbered after the highest existing id. */
export async function addTask(
  store: Store,
  input: NewTask,
  now = new Date(),
): Promise<ActionResult> {
  const parsed = NewTask.safeParse(input);
  if (!parsed.success) return { ok: false, message: z.prettifyError(parsed.error) };
  const { subtasks, ...fields } = parsed.data;

  return update(store, now, async (plan) => {
    const id = `T${Math.max(0, ...plan.tasks.map((t) => Number(t.id.slice(1)))) + 1}`;
    const task: Task = {
      ...fields,
      id,
      subtasks: subtasks.map((s, i) => ({ ...s, id: `${id}.${i + 1}`, status: 'planned' })),
    };
    return {
      plan: { ...plan, tasks: [...plan.tasks, task] },
      event: { type: 'task_added', taskId: id, message: `Added ${id} ${task.title}` },
    };
  });
}

export async function addSubtask(
  store: Store,
  taskId: string,
  input: { title: string; description?: string },
  now = new Date(),
): Promise<ActionResult> {
  return update(store, now, async (plan) => {
    const found = findItem(plan, taskId);
    if (!found || found.subtask) return `No task ${taskId}.`;
    const next = Math.max(0, ...found.task.subtasks.map((s) => Number(s.id.split('.')[1]))) + 1;
    const subtask: Subtask = {
      id: `${taskId}.${next}`,
      title: input.title,
      description: input.description ?? '',
      status: 'planned',
    };
    return {
      plan: replaceTask(plan, { ...found.task, subtasks: [...found.task.subtasks, subtask] }),
      event: { type: 'task_added', taskId: subtask.id, message: `Added subtask ${subtask.title}` },
    };
  });
}

interface Update {
  plan: Plan;
  event: { type: EventType; taskId: string; message: string };
}

/** Apply an edit, validate the whole plan, then save and log it. */
async function update(
  store: Store,
  now: Date,
  apply: (plan: Plan) => Promise<Update | string>,
): Promise<ActionResult> {
  const plan = await store.readPlan();
  if (!plan) return { ok: false, message: 'There is no plan yet.' };

  const result = await apply(plan);
  if (typeof result === 'string') return { ok: false, message: result };

  const valid = Plan.safeParse(result.plan);
  if (!valid.success) return { ok: false, message: z.prettifyError(valid.error) };

  await store.writePlan(valid.data);
  await store.appendEvent({ at: now.toISOString(), actor: 'user', ...result.event });
  return { ok: true, message: `${result.event.taskId}: ${result.event.message}` };
}

function replaceTask(plan: Plan, task: Task): Plan {
  return { ...plan, tasks: plan.tasks.map((t) => (t.id === task.id ? task : t)) };
}

function definedKeys(changes: object): string[] {
  return Object.entries(changes)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/** Drop keys whose value is undefined, so spreading never erases an existing field. */
function pickDefined<T extends object>(changes: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
