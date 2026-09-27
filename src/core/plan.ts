import type { Plan, Task } from './schema.js';

/**
 * The next task a worker should pick up: the first `todo` task, in plan order,
 * whose dependencies are all `done`. Returns `undefined` when nothing is ready.
 */
export function nextTask(plan: Plan): Task | undefined {
  const done = new Set(plan.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return plan.tasks.find((t) => t.status === 'todo' && t.dependsOn.every((dep) => done.has(dep)));
}

export function progress(plan: Plan): { done: number; total: number } {
  return {
    done: plan.tasks.filter((t) => t.status === 'done').length,
    total: plan.tasks.length,
  };
}

/** Lock the plan so work can begin. Approving twice keeps the original timestamp. */
export function approve(plan: Plan, at: Date): Plan {
  return plan.approvedAt ? plan : { ...plan, approvedAt: at.toISOString() };
}

/**
 * Carry progress from the current plan into a revised task list. Planners describe
 * the work; Dazza owns status, so any status the planner supplied is replaced.
 * Returns an error message if the revision would drop work that has already started.
 */
export function carryOverProgress(current: Plan | undefined, revised: Task[]): Task[] | string {
  const previous = new Map(current?.tasks.map((task) => [task.id, task]));

  const dropped = [...previous.values()]
    .filter((task) => task.status !== 'todo' && !revised.some((r) => r.id === task.id))
    .map((task) => `${task.id} (${task.status})`);
  if (dropped.length > 0) {
    return `These tasks have already started and can't be removed: ${dropped.join(', ')}`;
  }

  return revised.map((task) => {
    const before = previous.get(task.id);
    const doneSubtasks = new Set(before?.subtasks.filter((s) => s.done).map((s) => s.id));
    return {
      ...task,
      status: before?.status ?? 'todo',
      subtasks: task.subtasks.map((s) => ({ ...s, done: doneSubtasks.has(s.id) })),
    };
  });
}
