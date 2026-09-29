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

/** What's left of a build, in minutes, as of `at`. */
export interface TimeLeft {
  /** Minutes left on each open task (tasks in review are done, backlog isn't counted). */
  perTask: Record<string, number>;
  /** Tasks being built that have already taken longer than their size usually does. */
  overdue: string[];
  /** Minutes of building left, all tasks added up. */
  working: number;
  /**
   * Minutes until it's all built: tasks build side by side (`parallel` at a
   * time), but never before what they build on, so it's the longer of the
   * work shared out and the longest chain of dependent tasks.
   */
  wall: number;
  at: number;
}

/**
 * How long the rest of the build should take. Each task's size gives its
 * time (calibrated to this project, see sizeMinutes), less what's already been
 * spent on it. Only a guess: it doesn't know how long the user takes to answer
 * questions or review, so it counts building time only.
 */
export function timeLeft(
  plan: Plan,
  events: Event[],
  options: { parallel?: number; now?: number } = {},
): TimeLeft {
  const now = options.now ?? Date.now();
  const parallel = Math.max(1, options.parallel ?? 2);
  const minutes = sizeMinutes(plan, events);
  const perTask: Record<string, number> = {};
  const overdue: string[] = [];
  for (const task of plan.tasks) {
    if (!task.size || !OPEN.includes(task.status) || task.status === 'review') continue;
    const usual = minutes[task.size];
    const building = task.status === 'building';
    const left = usual - minutesSpent(events, task.id, building ? now : undefined);
    if (building && left < 1) overdue.push(task.id);
    // Rework after changes, or a task running long, still takes a little while.
    perTask[task.id] = Math.max(left, building ? 1 : Math.min(usual, REWORK_MINUTES));
  }
  const working = Object.values(perTask).reduce((sum, m) => sum + m, 0);

  // When each task can be done by, going by what it depends on.
  const finish = new Map<string, number>();
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const finishOf = (id: string, seen: Set<string>): number => {
    const known = finish.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // a cycle: plans are checked for these, but don't hang on one
    seen.add(id);
    const own = perTask[id] ?? 0;
    const after = Math.max(0, ...(byId.get(id)?.dependsOn ?? []).map((d) => finishOf(d, seen)));
    finish.set(id, own + after);
    return own + after;
  };
  const chain = Math.max(0, ...Object.keys(perTask).map((id) => finishOf(id, new Set())));
  const wall = Math.round(Math.max(chain, working / parallel));
  return { perTask, overdue, working: Math.round(working), wall, at: now };
}

/**
 * When each milestone should be built, from now: minutes until its tasks, and
 * the milestones before it, are all done. The first is when the user can
 * first try something.
 */
export function milestoneTimes(
  plan: Plan,
  events: Event[],
  options: { parallel?: number; now?: number } = {},
): { id: string; title: string; minutes: number }[] {
  const upTo = new Set<string>();
  return plan.milestones.map((milestone) => {
    for (const id of milestone.tasks) upTo.add(id);
    // Only this milestone's tasks and the ones before it: the rest can wait.
    const partial: Plan = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        upTo.has(t.id) || !OPEN.includes(t.status) ? t : { ...t, status: 'backlog' as const },
      ),
    };
    const { wall } = timeLeft(partial, events, options);
    return { id: milestone.id, title: milestone.title, minutes: wall };
  });
}

/** A task sent back for changes usually needs a fraction of its first build. */
const REWORK_MINUTES = 5;

/** "~12 min", "~1½ hours", "under a minute": for a countdown that updates as it goes. */
export function shortDuration(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  return humanDuration(minutes).replace('about ', '~');
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
 * stopped (handed over, blocked, or paused), added up. With `now`, a run still
 * going counts up to then.
 */
export function minutesSpent(events: Event[], taskId: string, now?: number): number {
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
  // Still being built: count the run so far too.
  if (now !== undefined && started !== undefined) total += Math.max(0, now - started);
  return Math.round(total / 60_000);
}
