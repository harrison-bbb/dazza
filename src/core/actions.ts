import { Git } from '../git/git.js';
import { approve, findItem, withStatus } from './plan.js';
import type { Actor, Plan } from './schema.js';
import type { Store } from './store.js';
import { landApprovedWork } from './work.js';

/**
 * Things the user can do to a project. The terminal and the board both go through
 * here, so the rules (e.g. only reviewed work can be closed) live in one place.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approvePlan(store: Store, now = new Date()): Promise<ActionResult> {
  const plan = await store.readPlan();
  if (!plan) return fail('Nothing to approve yet.');
  if (plan.approvedAt) return fail('Already approved.');

  await store.writePlan(approve(plan, now));
  await log(store, now, { type: 'plan_approved', message: 'Approved the plan' });
  return { ok: true, message: `Approved. ${plan.tasks.length} tasks locked in.` };
}

/** Comment on a task or subtask. Dazza comments through the same path. */
export async function addComment(
  store: Store,
  itemId: string,
  body: string,
  actor: Actor = 'user',
  now = new Date(),
): Promise<ActionResult> {
  const text = body.trim();
  if (!text) return fail('Comment is empty.');
  const plan = await store.readPlan();
  if (!plan || !findItem(plan, itemId)) return fail(`No task ${itemId}.`);

  await log(store, now, { type: 'comment', actor, taskId: itemId, message: text });
  return { ok: true, message: 'Comment added.' };
}

/** Accept work Dazza handed over. Only tasks in review can be closed. */
export async function closeTask(
  store: Store,
  taskId: string,
  now = new Date(),
): Promise<ActionResult> {
  const result = await transition(store, taskId, now, (plan, task) => {
    if (task.status !== 'review') return fail(`${taskId} isn't in review.`);
    return {
      plan: withStatus(plan, taskId, 'closed'),
      event: { type: 'task_approved', message: `Approved and closed ${task.title}` },
    };
  });
  if (!result.ok) return result;

  // Approved work lands on the base branch, in order.
  const landed = await landApprovedWork(store, new Git(store.root));
  const plan = await store.readPlan();
  const base = plan && findItem(plan, taskId)?.task.handoff?.baseBranch;
  if (landed.includes(taskId))
    return { ok: true, message: `${result.message}. Merged into ${base}.` };
  if (base) {
    return {
      ok: true,
      message: `${result.message}. It lands on ${base} once the work before it is approved.`,
    };
  }
  return result;
}

/** Send reviewed work back to Dazza with a note on what to change. */
export async function requestChanges(
  store: Store,
  taskId: string,
  note: string,
  now = new Date(),
): Promise<ActionResult> {
  if (!note.trim()) return fail('Say what needs to change.');
  const result = await transition(store, taskId, now, (plan, task) => {
    if (task.status !== 'review') return fail(`${taskId} isn't in review.`);
    return {
      plan: withStatus(plan, taskId, 'planned'),
      event: { type: 'task_rejected', message: `Requested changes to ${task.title}` },
    };
  });
  if (result.ok) await addComment(store, taskId, note, 'user', now);
  return result;
}

/** Drop a task from scope. Anything not already closed can be cancelled. */
export async function cancelTask(
  store: Store,
  taskId: string,
  now = new Date(),
): Promise<ActionResult> {
  return transition(store, taskId, now, (plan, task) => {
    if (task.status === 'closed' || task.status === 'cancelled') {
      return fail(`${taskId} is already ${task.status}.`);
    }
    return {
      plan: withStatus(plan, taskId, 'cancelled'),
      event: { type: 'task_cancelled', message: `Cancelled ${task.title}` },
    };
  });
}

/** Statuses the user can ask for. Building, review and blocked are Dazza's to set. */
export const REQUESTABLE_STATUSES = ['backlog', 'planned', 'closed', 'cancelled'] as const;
export type RequestableStatus = (typeof REQUESTABLE_STATUSES)[number];

/**
 * Move a task where the user wants it, with the same rules as the board:
 * close only reviewed work, send reviewed work back with a note, and move
 * work between backlog and planned (which also unblocks it).
 */
export async function setStatus(
  store: Store,
  taskId: string,
  status: RequestableStatus,
  note = '',
  now = new Date(),
): Promise<ActionResult> {
  if (status === 'closed') return closeTask(store, taskId, now);
  if (status === 'cancelled') return cancelTask(store, taskId, now);

  const plan = await store.readPlan();
  const current = plan && findItem(plan, taskId);
  if (current && !current.subtask && current.task.status === 'review' && status === 'planned') {
    return requestChanges(store, taskId, note, now);
  }

  const result = await transition(store, taskId, now, (plan, task) => {
    const movable = status === 'planned' ? ['backlog', 'blocked'] : ['planned', 'blocked'];
    if (!movable.includes(task.status)) {
      return fail(`${taskId} is ${task.status}; it can't move to ${status}.`);
    }
    return {
      plan: withStatus(plan, taskId, status),
      event: { type: 'task_moved', message: `Moved from ${task.status} to ${status}` },
    };
  });
  if (result.ok && note.trim()) await addComment(store, taskId, note, 'user', now);
  return result;
}

type Transition =
  | ActionResult
  | {
      plan: Plan;
      event: {
        type: 'task_approved' | 'task_rejected' | 'task_cancelled' | 'task_moved';
        message: string;
      };
    };

async function transition(
  store: Store,
  taskId: string,
  now: Date,
  apply: (plan: Plan, task: Plan['tasks'][number]) => Transition,
): Promise<ActionResult> {
  const plan = await store.readPlan();
  const found = plan && findItem(plan, taskId);
  if (!plan || !found || found.subtask) return fail(`No task ${taskId}.`);

  const result = apply(plan, found.task);
  if ('ok' in result) return result;

  await store.writePlan(result.plan);
  await log(store, now, { ...result.event, taskId });
  return { ok: true, message: result.event.message };
}

function log(
  store: Store,
  now: Date,
  event: {
    type: Parameters<Store['appendEvent']>[0]['type'];
    message: string;
    taskId?: string;
    actor?: Actor;
  },
): Promise<void> {
  return store.appendEvent({ at: now.toISOString(), actor: 'user', ...event });
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}
