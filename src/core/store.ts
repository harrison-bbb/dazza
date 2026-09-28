import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ProviderId } from '../providers/types.js';
import { withLock } from '../util/lock.js';
import { Event, type EventInput, Plan } from './schema.js';

export const STATE_DIR = '.dazza';

const MANAGER_SESSION_FILE = 'session.json';
const USAGE_FILE = 'usage.json';
const BUILD_FILE = 'build.json';
const PERMISSIONS_FILE = 'permissions.json';
const LOCAL_FILES = [
  MANAGER_SESSION_FILE,
  USAGE_FILE,
  BUILD_FILE,
  PERMISSIONS_FILE,
  '*.lock',
  'media/',
];

/** Machine-local bookkeeping for a task being built. */
export const TaskBuild = z.object({
  branch: z.string(),
  /** The worktree the task is built in. Missing for builds from before worktrees. */
  dir: z.string().optional(),
  baseBranch: z.string(),
  /** The commit the task started from, to measure what changed. */
  startCommit: z.string(),
  /** The worker's agent session, resumed when work continues. */
  sessionId: z.string().optional(),
  /** How much of the event log the worker has seen, so new comments reach it once. */
  seenEvents: z.number().int().nonnegative().default(0),
});
export type TaskBuild = z.infer<typeof TaskBuild>;
const BuildState = z.record(z.string(), TaskBuild);

/**
 * Commands the user has been asked about, per task: the one waiting for an
 * answer, and the exact commands they've allowed for that task.
 */
export const TaskPermissions = z.object({
  pending: z.object({ command: z.string(), why: z.string() }).optional(),
  allowed: z.array(z.string()).default([]),
});
export type TaskPermissions = z.infer<typeof TaskPermissions>;
const PermissionState = z.record(z.string(), TaskPermissions);

const ManagerSession = z.object({
  sessionId: z.string().min(1),
  provider: z.enum(['claude', 'codex']).optional(),
});

/** Running totals of what Dazza has used on this project. */
export const ProjectUsage = z.object({
  runs: z.number().int().nonnegative(),
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type ProjectUsage = z.infer<typeof ProjectUsage>;

/**
 * File-backed project state. Everything lives in `<root>/.dazza/` as plain,
 * human-readable files so the board, CLI and bot are just views over it.
 */
export class Store {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, STATE_DIR);
  }

  /**
   * Where a task is built: its own worktree, outside the project so the
   * project's tools (test runners, linters, watchers) never pick it up.
   */
  worktreeDir(taskId: string): string {
    const project = `${basename(this.root)}-${createHash('sha256').update(this.root).digest('hex').slice(0, 8)}`;
    return join(dataDir(), 'worktrees', project, taskId);
  }

  /** Held by whichever Dazza process is building this project. */
  get builderLockFile(): string {
    return this.path('builder.lock');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Dazza keeps .dazza/ out of git (see prepareRepo). This covers the machine-local
    // files too if someone commits the folder anyway.
    await writeFile(this.path('.gitignore'), `${LOCAL_FILES.join('\n')}\n`, 'utf8');
  }

  async readPlan(): Promise<Plan | undefined> {
    const raw = await this.readOptional('tasks.json');
    return raw === undefined ? undefined : parseState('tasks.json', raw, Plan);
  }

  /**
   * Read, change and write the plan under a lock, so concurrent writers (chat,
   * builder, agents) can't lose each other's updates. `change` returns the new
   * plan (or undefined to leave it) and a result to hand back.
   */
  async updatePlan<T>(
    change: (plan: Plan | undefined) => Promise<[Plan | undefined, T]> | [Plan | undefined, T],
  ): Promise<T> {
    await this.init();
    return withLock(this.path('tasks.lock'), async () => {
      const [next, result] = await change(await this.readPlan());
      if (next) await this.writePlan(next);
      return result;
    });
  }

  async writePlan(plan: Plan): Promise<void> {
    await this.writeAtomic('tasks.json', `${JSON.stringify(Plan.parse(plan), null, 2)}\n`);
  }

  async readScope(): Promise<string | undefined> {
    return this.readOptional('scope.md');
  }

  async writeScope(markdown: string): Promise<void> {
    await this.writeAtomic('scope.md', markdown);
  }

  /**
   * The manager conversation's agent session, so `dazza` picks up where it left
   * off. A session belongs to one agent CLI: after switching, there's none.
   */
  async readManagerSession(provider?: ProviderId): Promise<string | undefined> {
    const raw = await this.readOptional(MANAGER_SESSION_FILE);
    const parsed = ManagerSession.safeParse(safeJson(raw));
    if (!parsed.success) return undefined;
    const { sessionId, provider: owner } = parsed.data;
    return provider && owner && owner !== provider ? undefined : sessionId;
  }

  async writeManagerSession(sessionId: string, provider: ProviderId): Promise<void> {
    await this.writeAtomic(
      MANAGER_SESSION_FILE,
      `${JSON.stringify({ sessionId, provider }, null, 2)}\n`,
    );
  }

  /** Forget the conversation, e.g. to start fresh. The plan and board stay. */
  async clearManagerSession(): Promise<void> {
    await rm(this.path(MANAGER_SESSION_FILE), { force: true });
  }

  /** The close-out (or progress) report, written by Dazza for the user. */
  readReport(): Promise<string | undefined> {
    return this.readOptional('report.md');
  }

  async writeReport(markdown: string): Promise<void> {
    await this.writeAtomic('report.md', markdown);
  }

  /** Where a screenshot lives on disk, from its media path (e.g. "T3/home.png"). */
  mediaFile(path: string): string {
    return join(this.dir, 'media', path);
  }

  async mediaExists(path: string): Promise<boolean> {
    return access(this.mediaFile(path)).then(
      () => true,
      () => false,
    );
  }

  async readUsage(): Promise<ProjectUsage> {
    // A running total: if the file is damaged, starting again from zero is fine.
    const parsed = ProjectUsage.safeParse(safeJson(await this.readOptional(USAGE_FILE)));
    return parsed.success ? parsed.data : { runs: 0, tokens: 0, costUsd: 0 };
  }

  async recordUsage(run: { tokens: number; costUsd: number }): Promise<void> {
    await this.init();
    // The chat and the build record usage side by side; don't lose either.
    await withLock(this.path('usage.lock'), () => this.addUsage(run));
  }

  private async addUsage(run: { tokens: number; costUsd: number }): Promise<void> {
    const total = await this.readUsage();
    const next = {
      runs: total.runs + 1,
      tokens: total.tokens + run.tokens,
      costUsd: total.costUsd + run.costUsd,
    };
    await this.writeAtomic(USAGE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  }

  async readTaskBuild(taskId: string): Promise<TaskBuild | undefined> {
    return (await this.readTaskBuilds())[taskId];
  }

  async readTaskBuilds(): Promise<Record<string, TaskBuild>> {
    const raw = await this.readOptional(BUILD_FILE);
    return raw === undefined ? {} : parseState(BUILD_FILE, raw, BuildState);
  }

  async writeTaskBuild(taskId: string, build: TaskBuild): Promise<void> {
    await this.init();
    await withLock(this.path('build.lock'), async () => {
      const all = await this.readTaskBuilds();
      await this.writeAtomic(
        BUILD_FILE,
        `${JSON.stringify({ ...all, [taskId]: build }, null, 2)}\n`,
      );
    });
  }

  async readPermissions(taskId: string): Promise<TaskPermissions> {
    const all = PermissionState.safeParse(safeJson(await this.readOptional(PERMISSIONS_FILE)));
    return (all.success ? all.data[taskId] : undefined) ?? { allowed: [] };
  }

  /** Every task's request that's waiting for an answer. */
  async readPendingPermissions(): Promise<Record<string, { command: string; why: string }>> {
    const all = PermissionState.safeParse(safeJson(await this.readOptional(PERMISSIONS_FILE)));
    if (!all.success) return {};
    return Object.fromEntries(
      Object.entries(all.data).flatMap(([id, p]) => (p.pending ? [[id, p.pending]] : [])),
    );
  }

  async updatePermissions(
    taskId: string,
    change: (current: TaskPermissions) => TaskPermissions,
  ): Promise<void> {
    await this.init();
    await withLock(this.path('permissions.lock'), async () => {
      const parsed = PermissionState.safeParse(safeJson(await this.readOptional(PERMISSIONS_FILE)));
      const all = parsed.success ? parsed.data : {};
      const next = { ...all, [taskId]: change(all[taskId] ?? { allowed: [] }) };
      await this.writeAtomic(PERMISSIONS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  async appendEvent(event: EventInput): Promise<void> {
    await this.init();
    await appendFile(this.path('events.jsonl'), `${JSON.stringify(Event.parse(event))}\n`);
  }

  async readEvents(): Promise<Event[]> {
    const raw = await this.readOptional('events.jsonl');
    if (raw === undefined) return [];
    // One damaged line (say, from a crash mid-write) mustn't hide the rest.
    return raw.split('\n').flatMap((line) => {
      const parsed = Event.safeParse(safeJson(line));
      return parsed.success ? [parsed.data] : [];
    });
  }

  private path(file: string): string {
    return join(this.dir, file);
  }

  private async readOptional(file: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(file), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Write via temp file + rename so readers never observe a half-written file. */
  private async writeAtomic(file: string, contents: string): Promise<void> {
    await this.init();
    const target = this.path(file);
    // Unique per write: the chat and the build can write the same file at once.
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, contents, 'utf8');
    await rename(temp, target);
  }
}

/** A file Dazza can't work without, and can't safely guess at when it's damaged. */
export class StateError extends Error {
  override name = 'StateError';
}

function parseState<T>(file: string, raw: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(safeJson(raw));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  throw new StateError(
    `.dazza/${file} is damaged${where}${issue ? `: ${issue.message}` : ''}. ` +
      'Fix it by hand, or undo whatever last changed it.',
  );
}

function safeJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Per-user data that can be large, like worktrees. $DAZZA_DATA_DIR, or the XDG data dir. */
function dataDir(): string {
  if (process.env.DAZZA_DATA_DIR) return process.env.DAZZA_DATA_DIR;
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dazza');
}
