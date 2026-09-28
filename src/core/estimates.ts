import { type Event, type Plan, SIZE_MINUTES, type Task, type TaskSize } from './schema.js';

/**
 * Rough numbers about the build: how much is left, going by task sizes, and
 * how long tasks actually took, going by the event log.
 */

const OPEN: readonly Task['status'][] = ['planned', 'building', 'blocked', 'review'];

/** Finished tasks of a size it takes before their times replace the default. */
const MIN_SAMPLES = 2;

/**
 * How long each size takes on this project: the median time its finished tasks
 * of that size took, once there are a couple, otherwise the default. Builders
 * vary a lot between machines, models and codebases, so the project's own
 * record beats any fixed number.
 */
export function sizeMinutes(plan: Plan, events: Event[]): Record<TaskSize, number> {
  const taken: Record<TaskSize, number[]> = { S: [], M: [], L: [] };
  for (const task of plan.tasks) {
    if (!task.size || (task.status !== 'review' && task.status !== 'closed')) continue;
    const spent = minutesSpent(events, task.id);
    if (spent > 0) taken[task.size].push(spent);
  }
  const pick = (size: TaskSize) =>
    taken[size].length >= MIN_SAMPLES ? median(taken[size]) : SIZE_MINUTES[size];
  return { S: pick('S'), M: pick('M'), L: pick('L') };
}

/** Minutes of building left, from the sizes of tasks not yet done (backlog excluded). */
export function minutesLeft(plan: Plan, events: Event[] = []): number {
  const minutes = sizeMinutes(plan, events);
  return plan.tasks
    .filter((t) => OPEN.includes(t.status) && t.status !== 'review')
    .reduce((sum, t) => sum + (t.size ? minutes[t.size] : 0), 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** "about 2½ hours", "about 45 minutes". */
export function humanDuration(minutes: number): string {
  if (minutes < 60) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const halves = Math.round(minutes / 30) / 2;
  const hours = Number.isInteger(halves) ? `${halves}` : `${Math.floor(halves)}½`;
  return `about ${hours} hour${halves === 1 ? '' : 's'}`;
}

/**
 * How long the builder spent on a task: from each start to the next time it
 * stopped (handed over, blocked, or paused), added up.
 */
export function minutesSpent(events: Event[], taskId: string): number {
  let total = 0;
  let started: number | undefined;
  for (const event of events) {
    if (event.taskId !== taskId) continue;
    if (event.type === 'task_started') started = Date.parse(event.at);
    else if (
      started !== undefined &&
      (event.type === 'task_submitted' ||
        event.type === 'task_blocked' ||
        event.type === 'task_moved')
    ) {
      total += Date.parse(event.at) - started;
      started = undefined;
    }
  }
  return Math.round(total / 60_000);
}
