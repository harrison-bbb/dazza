import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Git, taskBranch } from '../git/git.js';
import type { ActionResult } from './actions.js';
import { checkChanges } from './hygiene.js';
import { findItem, withStatus } from './plan.js';
import {
  type EventType,
  type Handoff,
  MediaPath,
  type Plan,
  type Task,
  type TaskStatus,
} from './schema.js';
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
  criteria: z
    .array(
      z.object({
        criterion: z.string().min(1).describe('The acceptance criterion, as written.'),
        met: z.boolean(),
        evidence: z
          .string()
          .min(1)
          .describe('How you know: the test, command or check, and what it showed.'),
      }),
    )
    .min(1)
    .describe('Every acceptance criterion of the task, in order: met or not, and how you checked.'),
  checks: z
    .array(z.object({ name: z.string().min(1), passed: z.boolean() }))
    .default([])
    .describe('Automated checks you ran, e.g. { name: "Tests (24 passed)", passed: true }.'),
  screenshots: z
    .array(MediaPath)
    .default([])
    .describe('Screenshots of finished UI work, from the screenshot tool. Leave empty otherwise.'),
});
export type WorkReport = z.input<typeof WorkReport>;

/**
 * Get the repository ready to build in: a git repo with at least one commit,
 * and Dazza's state kept out of it. The user's checkout can have uncommitted
 * changes: tasks are built in worktrees of their own, which never touch it.
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
  // Branches need a commit to start from.
  if (!(await git.hasCommits())) await git.commitEmpty('Initial commit (before Dazza)');
  return { ok: true, created };
}

/** Why a task couldn't be set up to build, in words for the user. */
export class WorkError extends Error {
  override name = 'WorkError';
}

/**
 * Set a task up in its worktree and mark it building. A new task starts from
 * the user's branch, plus any approved work it depends on that hasn't landed
 * yet. A task built before resumes where it was, uncommitted work and all.
 * Throws a WorkError when it can't be set up.
 */
export async function startTask(
  store: Store,
  git: Git,
  task: Task,
  now = new Date(),
): Promise<TaskBuild> {
  const existing = await store.readTaskBuild(task.id);
  // The task brief carries everything said so far, so only later comments are news.
  const seenEvents = (await store.readEvents()).length;
  const build: TaskBuild = {
    ...(existing
      ? await reopenWorktree(store, git, task, existing)
      : await openWorktree(store, git, task)),
    seenEvents,
  };
  await store.writeTaskBuild(task.id, build);
  await setStatus(store, task.id, 'building', now, {
    type: 'task_started',
    message: existing ? 'Picked the task back up' : 'Started building',
  });
  return build;
}

async function openWorktree(store: Store, git: Git, task: Task): Promise<TaskBuild> {
  const dir = store.worktreeDir(task.id);
  const branch = taskBranch(task.id, task.title);
  const baseBranch = await projectBranch(store, git);
  await git.addWorktree(dir, branch, baseBranch);

  // Approved work this task builds on, if it hasn't landed on the base branch yet.
  const tree = new Git(dir);
  const plan = await store.readPlan();
  for (const dep of plan?.tasks.filter((t) => task.dependsOn.includes(t.id)) ?? []) {
    const commit = dep.handoff?.commit;
    if (!commit || (await git.isAncestor(commit, baseBranch))) continue;
    const merged = await tree.merge(commit, `Bring in ${dep.id}: ${dep.title}`);
    if (!merged.ok) {
      await git.removeWorktree(dir);
      await git.deleteBranch(branch);
      throw new WorkError(
        `${task.id} builds on ${dep.id}, which hasn’t landed on ${baseBranch} yet, and its work ` +
          `doesn’t merge cleanly. Land ${dep.id} first (see its task), then /build again.`,
      );
    }
  }
  return { branch, baseBranch, dir, startCommit: await tree.head(), seenEvents: 0 };
}

/** Pick up where an earlier attempt left off, recreating its worktree if it's gone. */
async function reopenWorktree(
  store: Store,
  git: Git,
  task: Task,
  build: TaskBuild,
): Promise<TaskBuild> {
  const dir = build.dir ?? store.worktreeDir(task.id);
  if (existsSync(join(dir, '.git'))) return { ...build, dir };
  const holder = await git.checkedOutAt(build.branch);
  if (holder) {
    throw new WorkError(
      `${build.branch} is checked out in ${holder}. Switch that checkout to another branch ` +
        `(e.g. git checkout ${build.baseBranch}) so I can build ${task.id} in a worktree of its own.`,
    );
  }
  await git.addWorktree(dir, build.branch, build.baseBranch);
  return { ...build, dir };
}

export async function setSubtaskStatus(
  store: Store,
  subtaskId: string,
  status: 'building' | 'closed',
  now = new Date(),
): Promise<ActionResult> {
  const title = await store.updatePlan((plan): [Plan | undefined, string | undefined] => {
    const found = plan && findItem(plan, subtaskId);
    // A dropped subtask stays dropped: the user decided that, not the builder.
    if (!plan || !found?.subtask || found.subtask.status === 'cancelled')
      return [undefined, undefined];
    return [withStatus(plan, subtaskId, status), found.subtask.title];
  });
  if (title === undefined) return { ok: false, message: `No subtask ${subtaskId}.` };
  if (status === 'closed') await log(store, now, 'task_progress', subtaskId, `Finished ${title}`);
  return { ok: true, message: `${subtaskId} is ${status}.` };
}

/** Stop and ask the user something. Dazza moves on to other work meanwhile. */
export async function blockTask(
  store: Store,
  taskId: string,
  question: string,
  { images = [], now = new Date() }: { images?: string[]; now?: Date } = {},
): Promise<ActionResult> {
  for (const image of images) {
    if (!(await store.mediaExists(image))) return { ok: false, message: `No screenshot ${image}.` };
  }
  const result = await setStatus(store, taskId, 'blocked', now, {
    type: 'task_blocked',
    message: 'Blocked: waiting on you',
  });
  if (result.ok) await log(store, now, 'comment', taskId, question, images);
  return result;
}

/** Commit the work in the task's worktree and hand it over for review. */
export async function submitTask(
  store: Store,
  taskId: string,
  report: WorkReport,
  now = new Date(),
): Promise<ActionResult> {
  const parsed = WorkReport.safeParse(report);
  if (!parsed.success) return { ok: false, message: z.prettifyError(parsed.error) };
  for (const image of parsed.data.screenshots) {
    if (!(await store.mediaExists(image))) return { ok: false, message: `No screenshot ${image}.` };
  }
  const build = await store.readTaskBuild(taskId);
  const plan = await store.readPlan();
  const current = plan && findItem(plan, taskId);
  const notBuilding = {
    ok: false,
    message: `${taskId} isn't being built, so there's nothing to hand over.`,
  } as const;
  if (!build || !current || current.subtask || current.task.status !== 'building')
    return notBuilding;

  const expected = current.task.acceptanceCriteria.length;
  if (parsed.data.criteria.length !== expected) {
    return {
      ok: false,
      message: `Not handed over: ${taskId} has ${expected} acceptance criteria and you reported on ${parsed.data.criteria.length}. Report on each one, in order.`,
    };
  }

  // Commit outside the plan lock: hooks can be slow, and nothing else writes to this worktree.
  const tree = new Git(build.dir ?? store.root);
  const problems = await checkChanges(tree, build.startCommit);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `Not handed over yet. Fix these first, then submit again:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    };
  }
  const commit = (await tree.commitAll(`${taskId}: ${current.task.title}`)) ?? (await tree.head());
  const handoff: Handoff = {
    ...parsed.data,
    branch: build.branch,
    ...(build.dir && { worktree: build.dir }),
    baseBranch: build.baseBranch,
    commit,
    filesChanged: await tree.filesChanged(build.startCommit, commit),
    submittedAt: now.toISOString(),
  };
  const handedOver = await store.updatePlan((plan): [Plan | undefined, boolean] => {
    const task = plan?.tasks.find((t) => t.id === taskId);
    if (!plan || task?.status !== 'building') return [undefined, false];
    const next = withStatus(plan, taskId, 'review');
    return [
      { ...next, tasks: next.tasks.map((t) => (t.id === taskId ? { ...t, handoff } : t)) },
      true,
    ];
  });
  if (!handedOver) return notBuilding;
  await log(store, now, 'task_submitted', taskId, 'Ready for your review');
  return { ok: true, message: `${taskId} committed on ${build.branch} and sent for review.` };
}

/**
 * Comments from the user about a task (or the project as a whole) that the
 * worker hasn't seen yet. Each one is handed over once.
 */
export async function takeNewMessages(store: Store, taskId: string): Promise<string[]> {
  const build = await store.readTaskBuild(taskId);
  const plan = await store.readPlan();
  const task = plan && findItem(plan, taskId)?.task;
  if (!build || !task) return [];

  const events = await store.readEvents();
  const ids = new Set([task.id, ...task.subtasks.map((s) => s.id)]);
  const news = events
    .slice(build.seenEvents)
    .filter((e) => e.type === 'comment' && e.actor === 'user' && (!e.taskId || ids.has(e.taskId)))
    .map((e) => `- On ${e.taskId ?? 'the project'}: ${e.message}`);
  await store.writeTaskBuild(taskId, { ...build, seenEvents: events.length });
  return news;
}

/** Put an interrupted task back in the queue; its branch and session are kept. */
export async function pauseTask(store: Store, taskId: string, now = new Date()): Promise<void> {
  await setStatus(
    store,
    taskId,
    'planned',
    now,
    { type: 'task_moved', message: 'Paused; picks up here next build' },
    'building',
  );
}

/**
 * The user's own branch, which work starts from and lands on: whatever their
 * checkout is on. If that's one of Dazza's task branches (someone checked it
 * out to try it), it's the branch that task came from.
 */
async function projectBranch(store: Store, git: Git): Promise<string> {
  const current = await git.currentBranch();
  if (current === 'HEAD') {
    throw new WorkError(
      'Your project isn’t on a branch (detached HEAD). Check out the branch you want the work to land on, then /build.',
    );
  }
  const builds = Object.values(await store.readTaskBuilds());
  return builds.find((b) => b.branch === current)?.baseBranch ?? current;
}

async function setStatus(
  store: Store,
  taskId: string,
  status: TaskStatus,
  now: Date,
  event: { type: EventType; message: string },
  /** Only change the status if it's currently this. */
  onlyFrom?: TaskStatus,
): Promise<ActionResult> {
  const changed = await store.updatePlan((plan): [Plan | undefined, boolean] => {
    const found = plan && findItem(plan, taskId);
    if (!plan || !found) return [undefined, false];
    if (onlyFrom && found.task.status !== onlyFrom) return [undefined, false];
    return [withStatus(plan, taskId, status), true];
  });
  if (!changed) return { ok: false, message: `${taskId} couldn't move to ${status}.` };
  await log(store, now, event.type, taskId, event.message);
  return { ok: true, message: `${taskId} is ${status}.` };
}

function log(
  store: Store,
  now: Date,
  type: EventType,
  taskId: string,
  message: string,
  images: string[] = [],
): Promise<void> {
  return store.appendEvent({
    at: now.toISOString(),
    actor: 'dazza',
    type,
    taskId,
    message,
    ...(images.length > 0 && { images }),
  });
}

/** What happened when Dazza tried to land approved work. */
export interface Landing {
  landed: string[];
  /** Approved tasks that couldn't land yet, with why, in words for the user. */
  held: Record<string, string>;
}

/**
 * Move approved work onto the branch it was built from: a fast-forward when
 * possible, otherwise a merge. A task lands only once the tasks it depends on
 * have, so approving T4 before T3 waits for T3, and approving T3 lands both.
 * Landed tasks' worktrees are removed; their branches stay.
 */
export async function landApprovedWork(store: Store, git: Git): Promise<Landing> {
  const result: Landing = { landed: [], held: {} };
  const plan = await store.readPlan();
  if (!plan || !(await git.isRepo())) return result;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  for (let progress = true; progress; ) {
    progress = false;
    for (const task of plan.tasks) {
      const { commit, baseBranch, branch } = task.handoff ?? {};
      if (task.status !== 'closed' || !commit || !baseBranch) continue;
      if (result.landed.includes(task.id) || task.id in result.held) continue;
      if (await git.isAncestor(commit, baseBranch)) continue; // already there

      const waiting = await waitingOn(git, task, byId, baseBranch);
      if (waiting === 'later') continue; // an approved dependency lands first
      if (waiting) {
        result.held[task.id] = waiting;
        continue;
      }
      const problem = await land(git, baseBranch, commit, `Merge ${task.id}: ${task.title}`);
      if (problem) {
        result.held[task.id] =
          problem === 'conflict'
            ? `It conflicts with changes on ${baseBranch}. Merge it yourself with git merge ${branch}.`
            : problem;
        continue;
      }
      result.landed.push(task.id);
      progress = true;
      const build = await store.readTaskBuild(task.id);
      if (build?.dir) await git.removeWorktree(build.dir);
    }
  }
  return result;
}

/**
 * What stops a task landing because of the tasks it depends on: 'later' when
 * an approved one just needs to land first, a reason when the user has to act,
 * or undefined when nothing does.
 */
async function waitingOn(
  git: Git,
  task: Task,
  tasks: Map<string, Task>,
  base: string,
): Promise<string | 'later' | undefined> {
  for (const id of task.dependsOn) {
    const dep = tasks.get(id);
    const commit = dep?.handoff?.commit;
    if (!dep || !commit || (await git.isAncestor(commit, base))) continue;
    if (dep.status === 'closed') return 'later';
    if (dep.status === 'cancelled') {
      return `It was built on ${id}, which you cancelled, so landing it would bring ${id}’s work too. Send it back to rebuild without it, or merge it yourself.`;
    }
    return `It lands once ${id} is approved, since it was built on ${id}’s work.`;
  }
  return undefined;
}

/**
 * Bring `commit` into `base`. Where the user has `base` checked out, the merge
 * happens there, but never over their uncommitted changes. Otherwise it happens
 * in a throwaway worktree. Returns 'conflict', a reason, or undefined on success.
 */
async function land(
  git: Git,
  base: string,
  commit: string,
  message: string,
): Promise<string | undefined> {
  const fastForward = await git.isAncestor(base, commit);
  const checkout = await git.checkedOutAt(base);

  if (checkout) {
    const there = new Git(checkout);
    const clean = await there.isClean();
    if (!fastForward && !clean) {
      return `You have uncommitted changes on ${base}. Commit or stash them, and I’ll land it at the next /build.`;
    }
    const merged = await there.merge(commit, message, { ffOnly: fastForward && !clean });
    if (merged.ok) return undefined;
    if (merged.conflict) return 'conflict';
    return clean
      ? `Git couldn’t merge it: ${merged.error}`
      : `Your uncommitted changes on ${base} touch the same files. Commit or stash them, and I’ll land it at the next /build.`;
  }

  if (fastForward) {
    await git.setBranch(base, commit);
    return undefined;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'dazza-land-'));
  try {
    await git.addDetachedWorktree(scratch, base);
    const there = new Git(scratch);
    const merged = await there.merge(commit, message);
    if (!merged.ok) return merged.conflict ? 'conflict' : `Git couldn’t merge it: ${merged.error}`;
    await git.setBranch(base, await there.head());
    return undefined;
  } finally {
    await git.removeWorktree(scratch);
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Put tasks a crashed or killed Dazza left mid-build back in the queue. Only
 * call this while holding the builder lock, so no live build is disturbed.
 * Their worktrees are kept, so the next build resumes the work.
 */
export async function recoverInterruptedWork(store: Store, now = new Date()): Promise<string[]> {
  const stuck = ((await store.readPlan())?.tasks ?? []).filter((t) => t.status === 'building');
  for (const task of stuck) {
    await setStatus(
      store,
      task.id,
      'planned',
      now,
      { type: 'task_moved', message: 'Dazza stopped mid-build; picks up here next build' },
      'building',
    );
  }
  return stuck.map((t) => t.id);
}

/** Remove worktrees of cancelled tasks. Landed tasks' are removed as they land. */
export async function tidyWorktrees(store: Store, git: Git): Promise<void> {
  const plan = await store.readPlan();
  const builds = await store.readTaskBuilds();
  for (const task of plan?.tasks ?? []) {
    const dir = builds[task.id]?.dir;
    if (task.status === 'cancelled' && dir && existsSync(dir)) await git.removeWorktree(dir);
  }
}
