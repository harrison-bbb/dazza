import type { Event, Milestone, Plan, Task } from './schema.js';
import type { Store } from './store.js';

/**
 * Milestones: stages the user can see and try. One is reached when all of
 * its tasks are closed (cancelled ones don't count against it). Reaching one
 * is recorded once, as an event, whichever way the last task was closed.
 */

export interface MilestoneProgress {
  milestone: Milestone;
  tasks: Task[];
  closed: number;
  /** Tasks still in scope: cancelled ones don't count. */
  total: number;
  reached: boolean;
}

export function milestoneProgress(plan: Plan): MilestoneProgress[] {
  return plan.milestones.map((milestone) => {
    const tasks = plan.tasks.filter((t) => milestone.tasks.includes(t.id));
    const inScope = tasks.filter((t) => t.status !== 'cancelled');
    const closed = inScope.filter((t) => t.status === 'closed').length;
    return {
      milestone,
      tasks,
      closed,
      total: inScope.length,
      reached: inScope.length > 0 && closed === inScope.length,
    };
  });
}

/** The first milestone not yet reached: what the build is working towards. */
export function currentMilestone(plan: Plan): MilestoneProgress | undefined {
  return milestoneProgress(plan).find((m) => !m.reached);
}

/** Milestones reached but not yet recorded: the ones to announce. */
export function newlyReached(plan: Plan, events: Event[]): MilestoneProgress[] {
  const recorded = new Set(
    events.filter((e) => e.type === 'milestone_reached').map((e) => e.message.split(':')[0]),
  );
  return milestoneProgress(plan).filter((m) => m.reached && !recorded.has(m.milestone.id));
}

/** Record any milestone just reached. Returns them, so the caller can say so. */
export async function recordMilestones(store: Store, now = new Date()): Promise<Milestone[]> {
  const plan = await store.readPlan();
  if (!plan) return [];
  const reached = newlyReached(plan, await store.readEvents());
  for (const { milestone } of reached) {
    await store.appendEvent({
      at: now.toISOString(),
      type: 'milestone_reached',
      actor: 'dazza',
      message: `${milestone.id}: ${milestone.title}`,
    });
  }
  return reached.map((m) => m.milestone);
}

/** Every task that's still in scope is closed. */
export function isComplete(plan: Plan): boolean {
  const inScope = plan.tasks.filter((t) => t.status !== 'cancelled');
  return (
    Boolean(plan.approvedAt) && inScope.length > 0 && inScope.every((t) => t.status === 'closed')
  );
}
