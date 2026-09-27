import { approve } from './plan.js';
import type { Store } from './store.js';

/**
 * Things the user can do to a project. The terminal and the board both go through
 * here, so they always behave identically.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approvePlan(store: Store, now = new Date()): Promise<ActionResult> {
  const plan = await store.readPlan();
  if (!plan) return { ok: false, message: 'Nothing to approve yet.' };
  if (plan.approvedAt) return { ok: false, message: 'Already approved.' };

  await store.writePlan(approve(plan, now));
  await store.appendEvent({
    at: now.toISOString(),
    type: 'plan_approved',
    message: 'Plan approved',
  });
  return { ok: true, message: `Approved. ${plan.tasks.length} tasks locked in.` };
}

export async function addComment(
  store: Store,
  taskId: string,
  body: string,
  now = new Date(),
): Promise<ActionResult> {
  const text = body.trim();
  if (!text) return { ok: false, message: 'Comment is empty.' };

  const plan = await store.readPlan();
  if (!plan?.tasks.some((task) => task.id === taskId)) {
    return { ok: false, message: `No task ${taskId}.` };
  }

  await store.appendEvent({ at: now.toISOString(), type: 'comment', taskId, message: text });
  return { ok: true, message: 'Comment added.' };
}
