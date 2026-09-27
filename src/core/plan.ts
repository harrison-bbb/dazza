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
