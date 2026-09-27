import { FINAL_STATUSES, type Plan, type Subtask, type Task, type TaskStatus } from './schema.js';

/**
 * The next task a worker should pick up: the first `planned` task, in plan order,
 * whose dependencies are all closed. Returns `undefined` when nothing is ready.
 */
export function nextTask(plan: Plan): Task | undefined {
  const closed = new Set(plan.tasks.filter((t) => t.status === 'closed').map((t) => t.id));
  return plan.tasks.find((t) => t.status === 'planned' && t.dependsOn.every((d) => closed.has(d)));
}

/** The task Dazza is building right now, if any. */
export function currentTask(plan: Plan): Task | undefined {
  return plan.tasks.find((t) => t.status === 'building');
}

/** Closed tasks out of all tasks still in scope (cancelled ones don't count). */
export function progress(plan: Plan): { closed: number; total: number } {
  const inScope = plan.tasks.filter((t) => t.status !== 'cancelled');
  return { closed: inScope.filter((t) => t.status === 'closed').length, total: inScope.length };
}

/** Lock the plan so work can begin. Approving twice keeps the original timestamp. */
export function approve(plan: Plan, at: Date): Plan {
  return plan.approvedAt ? plan : { ...plan, approvedAt: at.toISOString() };
}

/** Find a task or subtask by id, along with the task it belongs to. */
export function findItem(plan: Plan, id: string): { task: Task; subtask?: Subtask } | undefined {
  for (const task of plan.tasks) {
    if (task.id === id) return { task };
    const subtask = task.subtasks.find((s) => s.id === id);
    if (subtask) return { task, subtask };
  }
  return undefined;
}

/** Return a copy of the plan with one task or subtask's status changed. */
export function withStatus(plan: Plan, id: string, status: TaskStatus): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) =>
      task.id === id
        ? { ...task, status }
        : { ...task, subtasks: task.subtasks.map((s) => (s.id === id ? { ...s, status } : s)) },
    ),
  };
}

/**
 * Carry progress from the current plan into a revised task list. The planner may
 * file new items under `backlog` or `planned`; after that, Dazza owns status.
 * Returns an error message if the revision would drop work that has already started.
 */
export function carryOverProgress(current: Plan | undefined, revised: Task[]): Task[] | string {
  const previous = new Map(current?.tasks.map((task) => [task.id, task]));

  const dropped = [...previous.values()]
    .filter((task) => hasStarted(task.status) && !revised.some((r) => r.id === task.id))
    .map((task) => `${task.id} (${task.status})`);
  if (dropped.length > 0) {
    return `These tasks have already started and can't be removed: ${dropped.join(', ')}`;
  }

  return revised.map((task) => {
    const before = previous.get(task.id);
    const subtaskStatus = new Map(before?.subtasks.map((s) => [s.id, s.status]));
    return {
      ...task,
      status: before?.status ?? initialStatus(task.status),
      subtasks: task.subtasks.map((s) => ({
        ...s,
        status: subtaskStatus.get(s.id) ?? initialStatus(s.status),
      })),
    };
  });
}

function hasStarted(status: TaskStatus): boolean {
  return status !== 'planned' && status !== 'backlog' && !FINAL_STATUSES.includes(status);
}

function initialStatus(requested: TaskStatus): TaskStatus {
  return requested === 'backlog' ? 'backlog' : 'planned';
}
