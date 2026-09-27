import type { Event, Plan, Task, TaskStatus } from './api';

/**
 * Facts derived from the event log, so the board can say how long things have
 * taken and what was last said, without storing any of it twice.
 */

/** Which event puts a task into each status. */
const ENTERED_BY: Partial<Record<TaskStatus, Event['type'][]>> = {
  building: ['task_started'],
  review: ['task_submitted'],
  blocked: ['task_blocked'],
  closed: ['task_approved'],
  cancelled: ['task_cancelled'],
  planned: ['task_moved', 'task_rejected', 'plan_approved'],
};

/** When the task entered its current status, if the log says. */
export function statusSince(events: Event[], task: Task): string | undefined {
  const types = ENTERED_BY[task.status] ?? [];
  return findLast(
    events,
    (e) => types.includes(e.type) && (e.taskId === task.id || e.type === 'plan_approved'),
  )?.at;
}

/** Dazza's most recent comment on a task or any of its subtasks. */
export function latestUpdate(events: Event[], task: Task): Event | undefined {
  const ids = new Set([task.id, ...task.subtasks.map((s) => s.id)]);
  return findLast(
    events,
    (e) => e.type === 'comment' && e.actor === 'dazza' && ids.has(e.taskId ?? ''),
  );
}

/** What a blocked task is waiting on: Dazza's latest word since it got blocked. */
export function blockerFor(events: Event[], task: Task): string | undefined {
  if (task.status !== 'blocked') return undefined;
  const blockedAt = findLastIndex(events, (e) => e.type === 'task_blocked' && e.taskId === task.id);
  const since = blockedAt >= 0 ? events.slice(blockedAt) : events;
  const question = findLast(
    since,
    (e) => e.type === 'comment' && e.actor === 'dazza' && e.taskId === task.id,
  );
  return question?.message ?? events[blockedAt]?.message;
}

/** Milestones for one task, oldest first. */
export function milestones(events: Event[], taskId: string): { label: string; at: string }[] {
  const labels: Partial<Record<Event['type'], string>> = {
    task_started: 'Started',
    task_submitted: 'Submitted for review',
    task_rejected: 'Changes requested',
    task_blocked: 'Blocked',
    task_approved: 'Closed',
    task_cancelled: 'Cancelled',
  };
  return events.flatMap((e) => {
    const label = labels[e.type];
    return e.taskId === taskId && label ? [{ label, at: e.at }] : [];
  });
}

/** The planned task Dazza will pick up next: dependencies closed, in plan order. */
export function nextUp(plan: Plan): Task | undefined {
  const closed = new Set(plan.tasks.filter((t) => t.status === 'closed').map((t) => t.id));
  return plan.tasks.find((t) => t.status === 'planned' && t.dependsOn.every((d) => closed.has(d)));
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  const i = findLastIndex(items, match);
  return i >= 0 ? items[i] : undefined;
}

function findLastIndex<T>(items: T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && match(item)) return i;
  }
  return -1;
}
