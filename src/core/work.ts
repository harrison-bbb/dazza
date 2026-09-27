import { z } from 'zod';
import { type Git, taskBranch } from '../git/git.js';
import type { ActionResult } from './actions.js';
import { findItem, withStatus } from './plan.js';
import type { EventType, Handoff, Task, TaskStatus } from './schema.js';
import type { Store, TaskBuild } from './store.js';

/**
 * What happens to a task while Dazza builds it: start it on its own branch,
 * tick off subtasks, stop to ask the user something, and hand it over for
 * review. The worker agent drives these through Dazza's MCP tools.
 */

export const WorkReport = z.object({
  summary: z
    .string()
    .min(1)
    .describe('What you built, for the user. Plain language, a short paragraph.'),
  howToVerify: z
    .array(z.string().min(1))
    .min(1)
    .describe('Steps the user can follow to check it themselves.'),
  checks: z
    .array(z.object({ name: z.string().min(1), passed: z.boolean() }))
    .default([])
    .describe('Automated checks you ran, e.g. { name: "Tests (24 passed)", passed: true }.'),
});
export type WorkReport = z.input<typeof WorkReport>;

/**
 * Get the repository ready to build in. Returns a message for the user when it
 * isn't safe to start, e.g. uncommitted changes that aren't Dazza's.
 */
export async function prepareRepo(
  git: Git,
): Promise<{ ok: true; created: boolean } | { ok: false; message: string }> {
  let created = false;
  if (!(await git.isRepo())) {
    await git.init();
    created = true;
  }
  if (await git.tracks('.dazza')) {
    return {
      ok: false,
      message:
        'Dazza’s .dazza folder is committed in this repository. Remove it from git ' +
        '(git rm -r --cached .dazza, then commit) so task branches can’t overwrite the plan.',
    };
  }
  await git.excludeLocally('.dazza/');
  if (!(await git.isClean())) {
    return {
      ok: false,
      message:
        'You have uncommitted changes. Commit or stash them first, so Dazza’s work stays separate from yours.',
    };
  }
  return { ok: true, created };
}

/** Put the task on its branch and mark it building. Resumes an earlier attempt's branch. */
export async function startTask(
  store: Store,
  git: Git,
  task: Task,
  now = new Date(),
): Promise<TaskBuild> {
  const existing = await store.readTaskBuild(task.id);
  const build: TaskBuild = existing ?? {
    branch: taskBranch(task.id, task.title),
    baseBranch: await projectBranch(store, git),
    startCommit: await git.head(),
  };
  await git.checkout(build.branch);
  await store.writeTaskBuild(task.id, build);
  await setStatus(store, task.id, 'building', now, {
    type: 'task_started',
    message: existing ? 'Picked the task back up' : 'Started building',
  });
  return build;
}

export async function setSubtaskStatus(
  store: Store,
  subtaskId: string,
  status: 'building' | 'closed',
  now = new Date(),
): Promise<ActionResult> {
  const plan = await store.readPlan();
  const found = plan && findItem(plan, subtaskId);
  if (!plan || !found?.subtask) return { ok: false, message: `No subtask ${subtaskId}.` };
  await store.writePlan(withStatus(plan, subtaskId, status));
  if (status === 'closed') {
    await log(store, now, 'task_progress', subtaskId, `Finished ${found.subtask.title}`);
  }
  return { ok: true, message: `${subtaskId} is ${status}.` };
}

/** Stop and ask the user something. Dazza moves on to other work meanwhile. */
export async function blockTask(
  store: Store,
  taskId: string,
  question: string,
  now = new Date(),
): Promise<ActionResult> {
  const result = await setStatus(store, taskId, 'blocked', now, {
    type: 'task_blocked',
    message: 'Blocked: waiting on you',
  });
  if (result.ok) await log(store, now, 'comment', taskId, question);
  return result;
}

/** Commit the work and hand it over for review. */
export async function submitTask(
  store: Store,
  git: Git,
  taskId: string,
  report: WorkReport,
  now = new Date(),
): Promise<ActionResult> {
  const parsed = WorkReport.safeParse(report);
  if (!parsed.success) return { ok: false, message: z.prettifyError(parsed.error) };
  const plan = await store.readPlan();
  const task = plan && findItem(plan, taskId);
  const build = await store.readTaskBuild(taskId);
  if (!plan || !task || task.subtask || !build || task.task.status !== 'building') {
    return { ok: false, message: `${taskId} isn't being built, so there's nothing to hand over.` };
  }

  const commit = (await git.commitAll(`${taskId}: ${task.task.title}`)) ?? (await git.head());
  const handoff: Handoff = {
    ...parsed.data,
    branch: build.branch,
    baseBranch: build.baseBranch,
    commit,
    filesChanged: await git.filesChanged(build.startCommit, commit),
    screenshots: [],
    submittedAt: now.toISOString(),
  };
  const next = withStatus(plan, taskId, 'review');
  await store.writePlan({
    ...next,
    tasks: next.tasks.map((t) => (t.id === taskId ? { ...t, handoff } : t)),
  });
  await log(store, now, 'task_submitted', taskId, 'Ready for your review');
  return { ok: true, message: `${taskId} committed on ${build.branch} and sent for review.` };
}

/** Put an interrupted task back in the queue; its branch and session are kept. */
export async function pauseTask(store: Store, taskId: string, now = new Date()): Promise<void> {
  const plan = await store.readPlan();
  if (plan && findItem(plan, taskId)?.task.status === 'building') {
    await setStatus(store, taskId, 'planned', now, {
      type: 'task_moved',
      message: 'Paused; picks up here next build',
    });
  }
}

/**
 * The user's own branch that work lands on. When we're sitting on an earlier
 * task's branch (tasks stack), that's the branch the earlier task came from.
 */
async function projectBranch(store: Store, git: Git): Promise<string> {
  const current = await git.currentBranch();
  const builds = Object.values(await store.readTaskBuilds());
  return builds.find((b) => b.branch === current)?.baseBranch ?? current;
}

async function setStatus(
  store: Store,
  taskId: string,
  status: TaskStatus,
  now: Date,
  event: { type: EventType; message: string },
): Promise<ActionResult> {
  const plan = await store.readPlan();
  if (!plan || !findItem(plan, taskId)) return { ok: false, message: `No task ${taskId}.` };
  await store.writePlan(withStatus(plan, taskId, status));
  await log(store, now, event.type, taskId, event.message);
  return { ok: true, message: `${taskId} is ${status}.` };
}

function log(
  store: Store,
  now: Date,
  type: EventType,
  taskId: string,
  message: string,
): Promise<void> {
  return store.appendEvent({ at: now.toISOString(), actor: 'dazza', type, taskId, message });
}

/**
 * Move approved work onto the base branch. Tasks are built stacked, so a task
 * only lands once everything it was built on top of is already there: approving
 * T4 before T3 waits for T3, and approving T3 then lands both.
 * Returns the ids of tasks that landed.
 */
export async function landApprovedWork(store: Store, git: Git): Promise<string[]> {
  const plan = await store.readPlan();
  if (!plan || !(await git.isRepo())) return [];
  const landed: string[] = [];

  let progress = true;
  while (progress) {
    progress = false;
    for (const task of plan.tasks) {
      const { commit, baseBranch } = task.handoff ?? {};
      const build = await store.readTaskBuild(task.id);
      if (task.status !== 'closed' || !commit || !baseBranch || !build || landed.includes(task.id))
        continue;
      if (await git.isAncestor(commit, baseBranch)) continue; // already there
      if (!(await git.isAncestor(build.startCommit, baseBranch))) continue; // waits for earlier work
      if (await git.fastForward(baseBranch, commit)) {
        landed.push(task.id);
        progress = true;
      }
    }
  }
  return landed;
}
