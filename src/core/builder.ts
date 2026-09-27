import { setTimeout as sleep } from 'node:timers/promises';
import { Git } from '../git/git.js';
import { MCP_SERVER_NAME, WORKER_TOOLS } from '../mcp/server.js';
import workerPrompt from '../prompts/worker.md';
import type { AgentError, AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import type { Config } from './config.js';
import { explainAgentError } from './errors.js';
import { nextTask } from './plan.js';
import type { Event, Plan, Task } from './schema.js';
import type { Store, TaskBuild } from './store.js';
import { trackUsage } from './usage.js';
import { blockTask, pauseTask, prepareRepo, startTask } from './work.js';

export interface BuilderOptions {
  store: Store;
  config: Config;
  provider: AgentProvider;
  /** How the agent CLI should launch Dazza's MCP server. */
  mcpServer: McpServerConfig;
  signal?: AbortSignal;
  /** Overrides for the timing policy, e.g. in tests. */
  timing?: Partial<Timing>;
}

/** How patient the build is. */
export interface Timing {
  /** No activity at all for this long means the worker is stuck. */
  stallMs: number;
  /** Retries after the agent CLI crashes, resuming its session. */
  crashRetries: number;
  /** Retries when the service is overloaded, waiting longer each time. */
  overloadRetries: number;
  overloadDelayMs: number;
  /** How long to wait at a usage limit when the reset time is unknown. */
  limitFallbackMs: number;
  /** Extra time after a limit resets before resuming, so it has really lifted. */
  resumeMarginMs: number;
}

export const DEFAULT_TIMING: Timing = {
  // Long installs and test runs can be quiet for a while; twenty minutes of
  // complete silence is something else.
  stallMs: 20 * 60_000,
  crashRetries: 1,
  overloadRetries: 3,
  overloadDelayMs: 60_000,
  limitFallbackMs: 30 * 60_000,
  resumeMarginMs: 60_000,
};

/** What the build loop reports, for the CLI (and other channels) to show. */
export type BuildEvent =
  | { type: 'repo_created' }
  | { type: 'task_started'; task: Task; branch: string; resumed: boolean }
  | { type: 'agent'; task: Task; event: AgentEvent }
  | { type: 'task_finished'; task: Task; outcome: 'review' | 'blocked' | 'paused' }
  /** Holding off until a usage limit resets, or a busy service settles. */
  | { type: 'waiting'; task: Task; reason: 'usage_limit' | 'overloaded'; until: string }
  | { type: 'retrying'; task: Task; reason: string }
  | { type: 'stopped'; reason: string };

/** How one run of the worker ended. */
type Attempt =
  | { kind: 'finished'; finalText: string }
  | { kind: 'aborted' }
  | { kind: 'stalled' }
  | { kind: 'crashed'; message: string }
  | { kind: 'error'; error: AgentError };

/**
 * Build the plan: take the next ready task, build it on its own branch, and move
 * on once it's handed over or blocked. Waits out usage limits, retries crashes
 * and busy services, and stops a stuck worker. Runs until nothing is ready, the
 * user has to act, or it's aborted.
 */
export async function* build(options: BuilderOptions): AsyncGenerator<BuildEvent> {
  const { store, config, signal } = options;
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const git = new Git(store.root);

  const repo = await prepareRepo(git);
  if (!repo.ok) {
    yield { type: 'stopped', reason: repo.message };
    return;
  }
  if (repo.created) yield { type: 'repo_created' };

  while (!signal?.aborted) {
    const plan = await store.readPlan();
    if (!plan?.approvedAt) {
      yield {
        type: 'stopped',
        reason: 'The plan needs your approval before I can build. Use /approve.',
      };
      return;
    }
    const task = nextTask(plan);
    if (!task) {
      yield { type: 'stopped', reason: idleReason(plan) };
      return;
    }

    let crashes = 0;
    let overloads = 0;
    let announced = false;
    for (;;) {
      const resumed = (await store.readTaskBuild(task.id)) !== undefined;
      const build = await startTask(store, git, task);
      if (!announced) yield { type: 'task_started', task, branch: build.branch, resumed };
      announced = true;

      const attempt = yield* runWorker(options, plan, task, resumed, build, timing);

      if (attempt.kind === 'aborted') {
        await pauseTask(store, task.id);
        yield { type: 'task_finished', task, outcome: 'paused' };
        return;
      }
      if (attempt.kind === 'stalled') {
        await pauseTask(store, task.id);
        await blockTask(
          store,
          task.id,
          `I stopped because nothing happened for ${Math.round(timing.stallMs / 60_000)} minutes, so ` +
            'something was probably stuck (a command waiting for input, or a hung dev server). ' +
            'Tell me how to proceed, or /build to try again.',
        );
        yield { type: 'task_finished', task, outcome: 'blocked' };
        break;
      }
      if (attempt.kind === 'crashed') {
        if (crashes++ < timing.crashRetries) {
          yield {
            type: 'retrying',
            task,
            reason: `${options.provider.name} crashed (${attempt.message}). Trying again.`,
          };
          continue;
        }
        await pauseTask(store, task.id);
        await blockTask(
          store,
          task.id,
          `${options.provider.name} kept crashing on this task: ${attempt.message}`,
        );
        yield { type: 'task_finished', task, outcome: 'blocked' };
        break;
      }
      if (attempt.kind === 'error') {
        const { error } = attempt;
        await pauseTask(store, task.id);
        if (error.kind === 'usage_limit') {
          const until =
            error.resetsAt ??
            (await limitResetTime(options.provider, config)) ??
            inFuture(timing.limitFallbackMs);
          yield { type: 'waiting', task, reason: 'usage_limit', until };
          await sleepUntil(Date.parse(until) + timing.resumeMarginMs, signal);
          break; // back to the top: the task is picked up again, resuming its session
        }
        if (error.kind === 'overloaded' && overloads++ < timing.overloadRetries) {
          const until = inFuture(timing.overloadDelayMs * overloads);
          yield { type: 'waiting', task, reason: 'overloaded', until };
          await sleepUntil(Date.parse(until), signal);
          if (signal?.aborted) return;
          continue;
        }
        if (error.kind === 'credits' || error.kind === 'auth' || error.kind === 'overloaded') {
          yield {
            type: 'stopped',
            reason: explainAgentError(error, { taskId: task.id, provider: options.provider.id }),
          };
          return;
        }
        // Anything else: the worker stopped with an error; surface it below.
      }

      const finalText =
        attempt.kind === 'finished'
          ? attempt.finalText
          : attempt.kind === 'error'
            ? attempt.error.message
            : '';
      const status = (await store.readPlan())?.tasks.find((t) => t.id === task.id)?.status;
      if (status === 'review' || status === 'blocked') {
        yield { type: 'task_finished', task, outcome: status };
      } else {
        // The worker stopped without handing over or asking anything: surface it
        // to the user rather than silently retrying.
        await pauseTask(store, task.id);
        await blockTask(
          store,
          task.id,
          `I stopped before finishing this task.${finalText ? ` My last note: ${finalText}` : ''}`,
        );
        yield { type: 'task_finished', task, outcome: 'blocked' };
      }
      break;
    }
  }
}

/** One run of the worker on a task, with a watchdog for runs that go silent. */
async function* runWorker(
  options: BuilderOptions,
  plan: Plan,
  task: Task,
  resumed: boolean,
  build: TaskBuild,
  timing: Timing,
): AsyncGenerator<BuildEvent, Attempt> {
  const { store, config, provider, mcpServer, signal } = options;
  const run = new AbortController();
  const stopRun = () => run.abort();
  signal?.addEventListener('abort', stopRun);
  // A stop that came while the task was being set up still counts.
  if (signal?.aborted) run.abort();
  let stalled = false;
  let watchdog: NodeJS.Timeout | undefined;
  const feedWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      run.abort();
    }, timing.stallMs);
  };

  const { model } = await config.readSettings();
  let finalText = '';
  let error: AgentError | undefined;
  try {
    feedWatchdog();
    const events = provider.run({
      prompt: taskBrief(plan, task, await store.readScope(), await store.readEvents(), resumed),
      cwd: store.root,
      systemPrompt: workerPrompt,
      autonomous: true,
      allowedTools: WORKER_TOOLS,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      ...(build.sessionId && { resumeSessionId: build.sessionId }),
      ...(model && { model }),
      signal: run.signal,
    });
    for await (const event of events) {
      feedWatchdog();
      if (event.type === 'started')
        await store.writeTaskBuild(task.id, { ...build, sessionId: event.sessionId });
      if (event.type === 'finished') {
        finalText = event.output;
        error = event.error;
      }
      await trackUsage(store, config, event);
      yield { type: 'agent', task, event };
    }
  } catch (thrown) {
    if (signal?.aborted) return { kind: 'aborted' };
    if (stalled) return { kind: 'stalled' };
    return {
      kind: 'crashed',
      message: thrown instanceof Error ? thrown.message.slice(0, 300) : String(thrown),
    };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', stopRun);
  }
  if (signal?.aborted) return { kind: 'aborted' };
  if (stalled) return { kind: 'stalled' };
  return error && error.kind !== 'failed'
    ? { kind: 'error', error }
    : { kind: 'finished', finalText };
}

/** When the full usage window resets: live from the provider if it can tell us, else the last reading. */
async function limitResetTime(
  provider: AgentProvider,
  config: Config,
): Promise<string | undefined> {
  const windows =
    (await provider.readLimits?.().catch(() => undefined)) ?? (await config.readLimits())?.windows;
  const full = windows?.filter((w) => w.utilization >= 0.98) ?? [];
  return full
    .map((w) => w.resetsAt)
    .sort()
    .at(-1);
}

function inFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

async function sleepUntil(time: number, signal: AbortSignal | undefined): Promise<void> {
  const ms = Math.max(0, time - Date.now());
  await sleep(ms, undefined, signal ? { signal } : {}).catch(() => {});
}

/** Everything the worker needs to know about its task, in one message. */
export function taskBrief(
  plan: Plan,
  task: Task,
  scope: string | undefined,
  events: Event[],
  resumed: boolean,
): string {
  const ids = new Set([task.id, ...task.subtasks.map((s) => s.id)]);
  const thread = events
    .filter((e) => e.type === 'comment' && e.taskId && ids.has(e.taskId))
    .map((e) => `- ${e.actor === 'user' ? 'User' : 'You (Dazza)'} on ${e.taskId}: ${e.message}`);
  const done = plan.tasks.filter((t) => t.status === 'closed').map((t) => `${t.id} ${t.title}`);
  // What this task builds on, as its builder described it at handoff.
  const foundations = plan.tasks
    .filter((t) => task.dependsOn.includes(t.id) && t.handoff)
    .map((t) => `### ${t.id}: ${t.title}\n${t.handoff?.summary}`);
  // Work that belongs to other tasks, so this one stays in its lane.
  const later = plan.tasks
    .filter((t) => t.id !== task.id && ['planned', 'backlog', 'blocked'].includes(t.status))
    .map((t) => `- ${t.id} ${t.title}`);

  return [
    resumed
      ? `Continue building ${task.id}. You've worked on it before; check where things stand and carry on.`
      : `Build ${task.id}.`,
    '',
    `# ${task.id}: ${task.title}`,
    task.description,
    '',
    '## Done when',
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    '',
    '## Subtasks',
    ...task.subtasks.map(
      (s) => `- ${s.id} [${s.status}] ${s.title}${s.description ? `: ${s.description}` : ''}`,
    ),
    ...(thread.length > 0 ? ['', '## Comments on this task (newest last)', ...thread] : []),
    ...(done.length > 0 ? ['', '## Already built and approved', ...done.map((d) => `- ${d}`)] : []),
    ...(foundations.length > 0 ? ['', '## What this builds on', ...foundations] : []),
    ...(later.length > 0 ? ['', '## Coming in other tasks (leave these alone)', ...later] : []),
    ...(scope ? ['', '## Project scope', scope] : []),
  ].join('\n');
}

function idleReason(plan: Plan): string {
  const count = (status: Task['status']) => plan.tasks.filter((t) => t.status === status).length;
  if (plan.tasks.every((t) => t.status === 'closed' || t.status === 'cancelled')) {
    return 'Everything is built and closed.';
  }
  const waiting = [
    count('review') && `${count('review')} waiting for your review`,
    count('blocked') && `${count('blocked')} blocked on you`,
    count('planned') && `${count('planned')} waiting on those`,
  ].filter(Boolean);
  return `Nothing else is ready to build: ${waiting.join(', ')}.`;
}
