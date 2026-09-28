import { Git } from '../git/git.js';
import { recordMilestones } from './milestones.js';
import { approve, findItem, moveTask, waitingOn, withStatus } from './plan.js';
import type { Actor, Plan } from './schema.js';
import type { Store } from './store.js';
import { landApprovedWork } from './work.js';

/**
 * Things the user can do to a project. The terminal and the board both go through
 * here, so the rules (e.g. only reviewed work can be closed) live in one place.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approvePlan(store: Store, now = new Date()): Promise<ActionResult> {
  const result = await store.updatePlan((plan): [Plan | undefined, ActionResult] => {
    if (!plan) return [undefined, fail('Nothing to approve yet.')];
    if (plan.approvedAt) return [undefined, fail('Already approved.')];
    return [
      approve(plan, now),
      { ok: true, message: `Approved. ${plan.tasks.length} tasks locked in.` },
    ];
  });
  if (result.ok) await log(store, now, { type: 'plan_approved', message: 'Approved the plan' });
  return result;
}

export interface CommentOptions {
  /** Who is speaking; the user unless Dazza is. */
  actor?: Actor;
  /** Screenshots to share with the comment (media paths). */
  images?: string[];
  now?: Date;
}

/**
 * Comment on a task or subtask, or on the project as a whole when there's no
 * id. Dazza comments through the same path, sometimes with screenshots.
 */
export async function addComment(
  store: Store,
  itemId: string | undefined,
  body: string,
  { actor = 'user', images = [], now = new Date() }: CommentOptions = {},
): Promise<ActionResult> {
  const text = body.trim();
  if (!text) return fail('Comment is empty.');
  const plan = await store.readPlan();
  if (itemId !== undefined && (!plan || !findItem(plan, itemId))) return fail(`No task ${itemId}.`);
  for (const image of images) {
    if (!(await store.mediaExists(image)))
      return fail(`No screenshot ${image}. Take it with screenshot first.`);
  }

  await log(store, now, {
    type: 'comment',
    actor,
    message: text,
    ...(itemId && { taskId: itemId }),
    ...(images.length > 0 && { images }),
  });
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

  // Approved work lands on the branch it was built from, in dependency order.
  const landing = await landApprovedWork(store, new Git(store.root));
  const plan = await store.readPlan();
  const base = plan && findItem(plan, taskId)?.task.handoff?.baseBranch;
  const others = landing.landed.filter((id) => id !== taskId);
  const held = landing.held[taskId];
  const landed = landing.landed.includes(taskId)
    ? ` Merged into ${base}${others.length ? `, along with ${others.join(', ')}` : ''}.`
    : held
      ? ` It hasn’t landed yet: ${held}`
      : base
        ? ` It lands on ${base} once the work it builds on does.`
        : '';
  const reached = await recordMilestones(store, now);
  const milestone = reached.map((m) => ` That completes ${m.id}, ${m.title}.`).join('');
  return { ok: true, message: `${result.message}.${landed}${milestone}` };
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
  if (result.ok) await addComment(store, taskId, note, { now });
  return result;
}

/** Drop a task from scope. Anything not already closed can be cancelled. */
export async function cancelTask(
  store: Store,
  taskId: string,
  now = new Date(),
): Promise<ActionResult> {
  if (taskId.includes('.')) return cancelSubtask(store, taskId, now);
  const result = await transition(store, taskId, now, (plan, task) => {
    if (task.status === 'closed' || task.status === 'cancelled') {
      return fail(`${taskId} is already ${task.status}.`);
    }
    return {
      plan: withStatus(plan, taskId, 'cancelled'),
      event: { type: 'task_cancelled', message: `Cancelled ${task.title}` },
    };
  });
  // Dropping the last open task of a milestone completes it.
  if (result.ok) await recordMilestones(store, now);
  return result;
}

/**
 * Put a task first in line (or ahead of another), e.g. "do T7 next". Says
 * what it still waits on, since dependencies come before priority.
 */
export async function prioritise(
  store: Store,
  taskId: string,
  before?: string,
  now = new Date(),
): Promise<ActionResult> {
  const result = await store.updatePlan((plan): [Plan | undefined, ActionResult] => {
    if (!plan) return [undefined, fail('No plan yet.')];
    const moved = moveTask(plan, taskId, before);
    if (typeof moved === 'string') return [undefined, fail(moved)];
    const task = moved.tasks.find((t) => t.id === taskId);
    if (task && task.status !== 'planned' && task.status !== 'backlog') {
      return [undefined, fail(`${taskId} is ${task.status}, so there's nothing to reorder.`)];
    }
    const blockers = task ? waitingOn(moved, task).map((t) => `${t.id} (${t.status})`) : [];
    const where = before ? `ahead of ${before}` : 'first in line';
    return [
      moved,
      {
        ok: true,
        message: blockers.length
          ? `${taskId} is ${where}, but it can't start until ${blockers.join(', ')} ${blockers.length === 1 ? 'is' : 'are'} closed.`
          : `${taskId} is ${where}${task?.status === 'backlog' ? ', but still in the backlog: move it to planned to build it' : ''}.`,
      },
    ];
  });
  if (result.ok)
    await log(store, now, { type: 'task_moved', message: `Moved ${where(before)}`, taskId });
  return result;
}

function where(before: string | undefined): string {
  return before ? `ahead of ${before}` : 'to the front of the queue';
}

/** Drop one part of a task that's no longer wanted; the rest of the task carries on. */
async function cancelSubtask(store: Store, id: string, now: Date): Promise<ActionResult> {
  const result = await store.updatePlan((plan): [Plan | undefined, ActionResult] => {
    const found = plan && findItem(plan, id);
    if (!plan || !found?.subtask) return [undefined, fail(`No subtask ${id}.`)];
    if (found.subtask.status === 'closed' || found.subtask.status === 'cancelled') {
      return [undefined, fail(`${id} is already ${found.subtask.status}.`)];
    }
    return [
      withStatus(plan, id, 'cancelled'),
      { ok: true, message: `Cancelled ${found.subtask.title}` },
    ];
  });
  if (result.ok)
    await log(store, now, { type: 'task_cancelled', message: result.message, taskId: id });
  return result;
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
  if (result.ok && note.trim()) await addComment(store, taskId, note, { now });
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
  const outcome = await store.updatePlan((plan): [Plan | undefined, Transition] => {
    const found = plan && findItem(plan, taskId);
    if (!plan || !found || found.subtask) return [undefined, fail(`No task ${taskId}.`)];
    const result = apply(plan, found.task);
    return 'ok' in result ? [undefined, result] : [result.plan, result];
  });
  if ('ok' in outcome) return outcome;

  await log(store, now, { ...outcome.event, taskId });
  return { ok: true, message: outcome.event.message };
}

function log(
  store: Store,
  now: Date,
  event: {
    type: Parameters<Store['appendEvent']>[0]['type'];
    message: string;
    taskId?: string;
    actor?: Actor;
    images?: string[];
  },
): Promise<void> {
  return store.appendEvent({ at: now.toISOString(), actor: 'user', ...event });
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}
