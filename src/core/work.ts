import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Git, taskBranch } from '../git/git.js';
import { detectLauncher } from '../preview/app.js';
import type { ActionResult } from './actions.js';
import { keepDependencies, seedDependencies } from './deps.js';
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

/** Long enough for a few sentences; anything longer is technical detail. */
const SUMMARY_MAX = 500;

export const WorkReport = z.object({
  summary: z
    .string()
    .min(1)
    .max(
      SUMMARY_MAX,
      `Keep the summary to a few plain sentences (under ${SUMMARY_MAX} characters) and move the technical detail to details.`,
    )
    .describe(
      'For the user, who may not be a developer: what they can do now, in one to three plain sentences, plus anything they must do or know (in words, not commands). No file names, libraries or code.',
    ),
  details: z
    .string()
    .optional()
    .describe(
      'For a developer reviewing the work, and the builders after you: the technical choices, what changed where, and caveats. Short Markdown bullets.',
    ),
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
    .describe(
      'Screenshots of the finished UI, from the screenshot tool: required when you changed anything the user sees.',
    ),
  noScreenshots: z
    .string()
    .optional()
    .describe(
      'Only when you changed UI but couldn’t screenshot it: why, in a line (e.g. "the page needs a login I can’t create").',
    ),
  notes: z
    .string()
    .optional()
    .describe(
      'What the builders of later tasks should know: conventions you set, where things live, commands that matter, gotchas you hit. Short bullets. Leave out what the code or README already makes obvious.',
    ),
});
export type WorkReport = z.input<typeof WorkReport>;

/** Files that change what the user sees; tests and stories don't count. */
const UI_FILE =
  /^(?!.*(\.(test|spec|stories)\.|(^|\/)(__tests__|tests?|e2e)\/)).*\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/;

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
  await reuseDependencies(store, tree, dir, task.id);
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
  // Most users judge UI work by looking at it, not by reading a diff.
  const visual = (await tree.stagedFiles(build.startCommit)).filter((f) => UI_FILE.test(f.path));
  if (
    visual.length > 0 &&
    parsed.data.screenshots.length === 0 &&
    !parsed.data.noScreenshots?.trim()
  ) {
    return {
      ok: false,
      message:
        `Not handed over yet: you changed what the user sees (${visual
          .slice(0, 3)
          .map((f) => f.path)
          .join(', ')}${visual.length > 3 ? ', …' : ''}), so show it. ` +
        'Take screenshots of the finished screens with the screenshot tool and attach them. If you really can’t, say why in noScreenshots.',
    };
  }
  const commit = (await tree.commitAll(`${taskId}: ${current.task.title}`)) ?? (await tree.head());
  const { notes: _, noScreenshots: __, ...details } = parsed.data;
  const handoff: Handoff = {
    ...details,
    branch: build.branch,
    ...(build.dir && { worktree: build.dir }),
    baseBranch: build.baseBranch,
    commit,
    filesChanged: await tree.filesChanged(build.startCommit, commit),
    runnable: (await detectLauncher(build.dir ?? store.root)) !== undefined,
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
  if (parsed.data.notes?.trim())
    await store.addNotes(taskId, current.task.title, parsed.data.notes);
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
      if (build?.dir) await retireWorktree(store, git, build.dir);
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
/**
 * A fresh worktree has nothing installed. Copy in dependencies installed from
 * the same lockfile, so the builder doesn't spend minutes reinstalling them.
 * Only where git ignores node_modules, so the copy can never be committed.
 */
async function reuseDependencies(store: Store, tree: Git, dir: string, taskId: string) {
  // With the slash: a `node_modules/` rule only matches directories.
  if (!(await tree.isIgnored('node_modules/'))) return;
  const others = Object.values(await store.readTaskBuilds())
    .map((b) => b.dir)
    .filter((d): d is string => d !== undefined && d !== dir && existsSync(d));
  const from = await seedDependencies(dir, [store.root, ...others.reverse()], store.depsCacheDir);
  if (!from) return;
  await store
    .appendActivity({
      at: new Date().toISOString(),
      taskId,
      kind: 'status',
      text: 'Reused the installed packages: no reinstall needed unless they change',
    })
    .catch(() => {});
}

/** Remove a task's worktree, keeping its installed dependencies for the next one. */
async function retireWorktree(store: Store, git: Git, dir: string): Promise<void> {
  await keepDependencies(dir, store.depsCacheDir).catch(() => undefined);
  await git.removeWorktree(dir);
}

export async function tidyWorktrees(store: Store, git: Git): Promise<void> {
  const plan = await store.readPlan();
  const builds = await store.readTaskBuilds();
  for (const task of plan?.tasks ?? []) {
    const dir = builds[task.id]?.dir;
    if (task.status === 'cancelled' && dir && existsSync(dir))
      await retireWorktree(store, git, dir);
  }
}

/**
 * Throw away a task's work and build it again from scratch: for when the work
 * isn't worth fixing. Its worktree, branch and handoff go; the task goes back
 * in the queue with its subtasks reset, and the note (what to do differently)
 * reaches the next build. Approved work is on the user's branch, so it can't be
 * started over here.
 */
export async function redoTask(
  store: Store,
  git: Git,
  taskId: string,
  note = '',
  now = new Date(),
): Promise<ActionResult> {
  const plan = await store.readPlan();
  const task = plan?.tasks.find((t) => t.id === taskId);
  if (!plan || !task) return { ok: false, message: `No task ${taskId}.` };
  if (task.status === 'building') {
    return { ok: false, message: `${taskId} is being built. /stop first, then start it over.` };
  }
  if (task.status === 'closed') {
    return {
      ok: false,
      message: `${taskId} is approved and merged into your branch, so it can’t be started over here.`,
    };
  }
  if (task.status === 'cancelled') return { ok: false, message: `${taskId} is cancelled.` };

  // Tasks built on top of this one (while it waited for review) carry the work
  // being thrown away, so they start over too.
  const built = await builtOn(store, git, plan, taskId);
  const busy = built.find((t) => t.status === 'building');
  if (busy) {
    return {
      ok: false,
      message: `${busy.id} is being built on ${taskId}’s work. /stop first, then start ${taskId} over.`,
    };
  }
  for (const later of built) await redoTask(store, git, later.id, '', now);

  const build = await store.readTaskBuild(taskId);
  if (build) {
    if (build.dir) await retireWorktree(store, git, build.dir);
    await git.deleteBranch(build.branch);
    await store.removeTaskBuild(taskId);
  }
  await store.updatePermissions(taskId, () => ({ allowed: [] }));
  await store.updatePlan((current): [Plan | undefined, undefined] => {
    if (!current) return [undefined, undefined];
    return [
      {
        ...current,
        tasks: current.tasks.map((t) =>
          t.id === taskId
            ? {
                ...withoutHandoff(t),
                status: t.status === 'backlog' ? 'backlog' : 'planned',
                subtasks: t.subtasks.map((s) =>
                  s.status === 'cancelled' ? s : { ...s, status: 'planned' as const },
                ),
              }
            : t,
        ),
      },
      undefined,
    ];
  });
  await log(store, now, 'task_moved', taskId, 'Started over: the earlier work was thrown away');
  await store
    .appendActivity({
      at: now.toISOString(),
      taskId,
      kind: 'status',
      text: 'Started over from scratch',
    })
    .catch(() => {});
  if (note.trim()) {
    await store.appendEvent({
      at: now.toISOString(),
      actor: 'user',
      type: 'comment',
      taskId,
      message: `Starting over. ${note.trim()}`,
    });
  }
  const also =
    built.length > 0
      ? ` ${built.map((t) => t.id).join(', ')} ${built.length === 1 ? 'was' : 'were'} built on it, so ${built.length === 1 ? 'it starts' : 'they start'} over too.`
      : '';
  return {
    ok: true,
    message: `Threw away ${taskId}’s work. It’s back in the queue and starts from scratch${note.trim() ? ', with your note' : ''}.${also}`,
  };
}

/** Open tasks whose work includes `taskId`'s: they were built on top of it. */
async function builtOn(store: Store, git: Git, plan: Plan, taskId: string): Promise<Task[]> {
  const build = await store.readTaskBuild(taskId);
  const tip = build && (await git.revParse(build.branch));
  // Its first commit: a branch holding any of its work holds that one.
  const first = build && tip && (await git.firstCommitAfter(build.startCommit, tip));
  if (!first) return [];
  const found: Task[] = [];
  for (const other of plan.tasks) {
    if (other.id === taskId || other.status === 'closed' || other.status === 'cancelled') continue;
    const theirs = await store.readTaskBuild(other.id);
    const head = theirs && (await git.revParse(theirs.branch));
    if (head && (await git.isAncestor(first, head))) found.push(other);
  }
  return found;
}

function withoutHandoff(task: Task): Task {
  const { handoff: _, ...rest } = task;
  return rest;
}
