import { type Config, DEFAULT_PARALLEL } from '../core/config.js';
import { shortDuration, type TimeLeft, timeLeft } from '../core/estimates.js';
import type { Event } from '../core/schema.js';
import type { Store } from '../core/store.js';

/** How the project stands, for anything that says how long's left (and what's being asked). */
export async function projectEstimate(
  store: Store,
  config: Config,
): Promise<{ left?: TimeLeft; ahead: boolean; events?: Event[] }> {
  const settings = await config.readSettings();
  const plan = await store.readPlan();
  const ahead = settings.buildAhead !== false;
  if (!plan) return { ahead };
  const events = await store.readEvents();
  return {
    left: timeLeft(plan, events, { parallel: settings.parallelTasks ?? DEFAULT_PARALLEL }),
    ahead,
    events,
  };
}

/**
 * The build's line in the status bar, counting down as it goes, e.g.
 * "Building T3 · ~12 min left · all built in ~40 min". Worked out from a
 * snapshot of the estimate (see timeLeft) and the time since it was taken, so
 * each redraw is cheap; the caller takes a fresh snapshot now and then.
 */
export function buildStatus(
  building: readonly string[],
  left: TimeLeft | undefined,
  now: () => number = Date.now,
): () => string {
  return () => {
    if (building.length === 0) return 'Looking for the next task';
    if (!left) return `Building ${building.join(' and ')}`;
    const gone = (now() - left.at) / 60_000;
    const remaining = (id: string) => (left.perTask[id] ?? 0) - gone;
    /** Undefined for a task with no size: no estimate is better than a made-up one. */
    const label = (id: string) => {
      if (left.perTask[id] === undefined) return undefined;
      if (left.overdue.includes(id)) return 'taking longer than usual';
      const r = remaining(id);
      return r < 1 ? 'almost done' : `${shortDuration(r)} left`;
    };
    const tasks =
      building.length === 1
        ? [`Building ${building[0]}`, label(building[0] ?? '')].filter(Boolean).join(' · ')
        : `Building ${building
            .map((id) => {
              const l = label(id);
              return l ? `${id} (${l})` : id;
            })
            .join(' and ')}`;
    // Only worth saying when there's more to build than what's running now.
    const more = Object.keys(left.perTask).some((id) => !building.includes(id));
    const longest = Math.max(0, ...building.filter((id) => id in left.perTask).map(remaining));
    const all = Math.max(left.wall - gone, longest);
    return more && all >= 1 ? `${tasks} · all built in ${shortDuration(all)}` : tasks;
  };
}

/** "3 of 11 built · about 2 hours to go", for a message to the phone. Undefined when it's all built. */
export function progressLine(built: number, total: number, left: TimeLeft): string | undefined {
  if (left.wall < 1) return undefined;
  return `${built} of ${total} built · ${shortDuration(left.wall).replace('~', 'about ')} of building to go`;
}
