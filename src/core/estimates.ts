import { type Event, type Plan, SIZE_MINUTES, type Task } from './schema.js';

/**
 * Rough numbers about the build: how much is left, going by task sizes, and
 * how long tasks actually took, going by the event log.
 */

const OPEN: readonly Task['status'][] = ['planned', 'building', 'blocked', 'review'];

/** Minutes of building left, from the sizes of tasks not yet done (backlog excluded). */
export function minutesLeft(plan: Plan): number {
  return plan.tasks
    .filter((t) => OPEN.includes(t.status) && t.status !== 'review')
    .reduce((sum, t) => sum + (t.size ? SIZE_MINUTES[t.size] : 0), 0);
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
