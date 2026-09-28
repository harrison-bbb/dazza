import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ProviderId } from '../providers/types.js';
import { withLock } from '../util/lock.js';
import { parseJson } from '../util/text.js';
import { type Activity, Event, type EventInput, Plan } from './schema.js';

export const STATE_DIR = '.dazza';

const MANAGER_SESSION_FILE = 'session.json';
/** What the user typed at the prompt, one JSON string per line. */
const HISTORY_FILE = 'history.jsonl';
const MAX_HISTORY = 500;
const USAGE_FILE = 'usage.json';
const BUILD_FILE = 'build.json';
const PERMISSIONS_FILE = 'permissions.json';
/** What each builder did, a file per task. */
const ACTIVITY = 'activity';
const ActivityLine = z.object({
  at: z.string(),
  taskId: z.string(),
  kind: z.enum(['say', 'do', 'status']),
  text: z.string(),
});
/** Every version of the scope, by when it was saved. */
const SCOPE_HISTORY = 'scope-history';
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

const Conversation = z.object({
  sessionId: z.string().min(1),
  provider: z.enum(['claude', 'codex']).optional(),
});

/**
 * The conversation with Dazza: the current one, and the one before it, kept
 * so `/continue` (or `dazza --continue`) can go back to it. Each launch starts
 * a new one, as Claude Code does.
 */
const ManagerSession = Conversation.extend({
  sessionId: z.string().min(1).optional(),
  previous: Conversation.optional(),
});
type ManagerSession = z.infer<typeof ManagerSession>;

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

  /** Save the scope. Every version is kept too, so any can be looked at or restored. */
  async writeScope(markdown: string, now = new Date()): Promise<void> {
    await this.writeAtomic('scope.md', markdown);
    await mkdir(this.path(SCOPE_HISTORY), { recursive: true });
    await writeFile(this.path(`${SCOPE_HISTORY}/${now.getTime()}.md`), markdown, 'utf8');
  }

  /** Every saved version of the scope, oldest first. */
  async scopeVersions(): Promise<{ id: string; at: string }[]> {
    const files = await readdir(this.path(SCOPE_HISTORY)).catch(() => [] as string[]);
    return files
      .filter((f) => /^\d+\.md$/.test(f))
      .map((f) => Number(f.slice(0, -3)))
      .sort((a, b) => a - b)
      .map((time) => ({ id: String(time), at: new Date(time).toISOString() }));
  }

  async readScopeVersion(id: string): Promise<string | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    return this.readOptional(`${SCOPE_HISTORY}/${id}.md`);
  }

  /**
   * The manager conversation's agent session, so `dazza` picks up where it left
   * off. A session belongs to one agent CLI: after switching, there's none.
   */
  async readManagerSession(provider?: ProviderId): Promise<string | undefined> {
    const { sessionId, provider: owner } = await this.readConversations();
    return provider && owner && owner !== provider ? undefined : sessionId;
  }

  async writeManagerSession(sessionId: string, provider: ProviderId): Promise<void> {
    const { previous } = await this.readConversations();
    await this.writeConversations({ sessionId, provider, ...(previous && { previous }) });
  }

  /** Whether there's an earlier conversation to go back to, for this agent. */
  async hasPreviousConversation(provider: ProviderId): Promise<boolean> {
    const { previous } = await this.readConversations();
    return previous !== undefined && (!previous.provider || previous.provider === provider);
  }

  /**
   * Start a new conversation, keeping the current one (if it got going) as the
   * one `/continue` goes back to. The plan and board stay.
   */
  async newConversation(): Promise<void> {
    const { sessionId, provider, previous } = await this.readConversations();
    const current = sessionId ? { sessionId, ...(provider && { provider }) } : undefined;
    const keep = current ?? previous;
    await this.writeConversations(keep ? { previous: keep } : {});
  }

  /**
   * Go back to the previous conversation. The current one, if it got going,
   * becomes the previous, so switching back and forth loses nothing. False
   * when there's nothing to go back to.
   */
  async continueConversation(provider: ProviderId): Promise<boolean> {
    const { sessionId, provider: owner, previous } = await this.readConversations();
    if (!previous || (previous.provider && previous.provider !== provider)) return false;
    const current = sessionId ? { sessionId, ...(owner && { provider: owner }) } : undefined;
    await this.writeConversations({ ...previous, ...(current && { previous: current }) });
    return true;
  }

  /** Forget the current conversation, e.g. when its agent session is gone. The plan and board stay. */
  async clearManagerSession(): Promise<void> {
    const { previous } = await this.readConversations();
    await this.writeConversations(previous ? { previous } : {});
  }

  private async readConversations(): Promise<ManagerSession> {
    const parsed = ManagerSession.safeParse(
      parseJson(await this.readOptional(MANAGER_SESSION_FILE)),
    );
    return parsed.success ? parsed.data : {};
  }

  private async writeConversations(state: ManagerSession): Promise<void> {
    await this.writeAtomic(MANAGER_SESSION_FILE, `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * What builders have learned about the project, task by task: conventions
   * set, commands that matter, gotchas. Each task's builder reads it first.
   */
  readNotes(): Promise<string | undefined> {
    return this.readOptional('notes.md');
  }

  async addNotes(taskId: string, title: string, notes: string): Promise<void> {
    await this.init();
    await withLock(this.path('notes.lock'), async () => {
      const current = (await this.readNotes()) ?? '# Project notes\n';
      await this.writeAtomic(
        'notes.md',
        `${current.trimEnd()}\n\n## ${taskId}: ${title}\n\n${notes.trim()}\n`,
      );
    });
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
    const parsed = ProjectUsage.safeParse(parseJson(await this.readOptional(USAGE_FILE)));
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
    const all = PermissionState.safeParse(parseJson(await this.readOptional(PERMISSIONS_FILE)));
    return (all.success ? all.data[taskId] : undefined) ?? { allowed: [] };
  }

  /** Every task's request that's waiting for an answer. */
  async readPendingPermissions(): Promise<Record<string, { command: string; why: string }>> {
    const all = PermissionState.safeParse(parseJson(await this.readOptional(PERMISSIONS_FILE)));
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
      const parsed = PermissionState.safeParse(
        parseJson(await this.readOptional(PERMISSIONS_FILE)),
      );
      const all = parsed.success ? parsed.data : {};
      const next = { ...all, [taskId]: change(all[taskId] ?? { allowed: [] }) };
      await this.writeAtomic(PERMISSIONS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  async appendActivity(entry: {
    at: string;
    taskId: string;
    kind: string;
    text: string;
  }): Promise<void> {
    await mkdir(this.path(ACTIVITY), { recursive: true });
    await appendFile(this.path(`${ACTIVITY}/${entry.taskId}.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  /** A task's latest activity, oldest first. */
  async readActivity(taskId: string, limit = 200): Promise<Activity[]> {
    if (!/^T\d+$/.test(taskId)) return [];
    const raw = (await this.readOptional(`${ACTIVITY}/${taskId}.jsonl`)) ?? '';
    return raw
      .split('\n')
      .slice(-limit - 1)
      .flatMap((line) => {
        const parsed = ActivityLine.safeParse(parseJson(line));
        return parsed.success ? [parsed.data] : [];
      })
      .slice(-limit);
  }

  /** Forget a task's build: it starts from scratch next time. */
  async removeTaskBuild(taskId: string): Promise<void> {
    await this.init();
    await withLock(this.path('build.lock'), async () => {
      const { [taskId]: _, ...rest } = await this.readTaskBuilds();
      await this.writeAtomic(BUILD_FILE, `${JSON.stringify(rest, null, 2)}\n`);
    });
  }

  /** What the user has typed in this project, oldest first, for ↑ at the prompt. */
  async readHistory(): Promise<string[]> {
    const raw = (await this.readOptional(HISTORY_FILE)) ?? '';
    return raw
      .split('\n')
      .flatMap((line) => {
        const entry = parseJson(line);
        return typeof entry === 'string' ? [entry] : [];
      })
      .slice(-MAX_HISTORY);
  }

  /** Add to the history; trimmed to the latest entries now and then. */
  async appendHistory(entry: string): Promise<void> {
    await this.init();
    await appendFile(this.path(HISTORY_FILE), `${JSON.stringify(entry)}\n`);
    const all = await this.readHistory();
    if (all.length >= MAX_HISTORY) {
      await this.writeAtomic(HISTORY_FILE, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
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
      const parsed = Event.safeParse(parseJson(line));
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
  const parsed = schema.safeParse(parseJson(raw));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  throw new StateError(
    `.dazza/${file} is damaged${where}${issue ? `: ${issue.message}` : ''}. ` +
      'Fix it by hand, or undo whatever last changed it.',
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Per-user data that can be large, like worktrees. $DAZZA_DATA_DIR, or the XDG data dir. */
function dataDir(): string {
  if (process.env.DAZZA_DATA_DIR) return process.env.DAZZA_DATA_DIR;
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dazza');
}
