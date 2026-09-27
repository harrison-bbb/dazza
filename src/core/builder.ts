import { Git } from '../git/git.js';
import { MCP_SERVER_NAME, WORKER_TOOLS } from '../mcp/server.js';
import workerPrompt from '../prompts/worker.md';
import type { AgentEvent, AgentProvider, McpServerConfig } from '../providers/types.js';
import type { Config } from './config.js';
import { nextTask } from './plan.js';
import type { Event, Plan, Task } from './schema.js';
import type { Store } from './store.js';
import { trackUsage } from './usage.js';
import { blockTask, pauseTask, prepareRepo, startTask } from './work.js';

export interface BuilderOptions {
  store: Store;
  config: Config;
  provider: AgentProvider;
  /** How the agent CLI should launch Dazza's MCP server. */
  mcpServer: McpServerConfig;
  signal?: AbortSignal;
}

/** What the build loop reports, for the CLI (and later other channels) to show. */
export type BuildEvent =
  | { type: 'repo_created' }
  | { type: 'task_started'; task: Task; branch: string; resumed: boolean }
  | { type: 'agent'; task: Task; event: AgentEvent }
  | { type: 'task_finished'; task: Task; outcome: 'review' | 'blocked' | 'paused' }
  | { type: 'stopped'; reason: string };

/**
 * Build the plan: take the next ready task, build it on its own branch, and move
 * on once it's handed over or blocked. Runs until nothing is ready or it's aborted.
 */
export async function* build(options: BuilderOptions): AsyncGenerator<BuildEvent> {
  const { store, config, provider, mcpServer, signal } = options;
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

    const resumed = (await store.readTaskBuild(task.id)) !== undefined;
    const build = await startTask(store, git, task);
    yield { type: 'task_started', task, branch: build.branch, resumed };

    const { model } = await config.readSettings();
    let finalText = '';
    try {
      const events = provider.run({
        prompt: taskBrief(plan, task, await store.readScope(), await store.readEvents(), resumed),
        cwd: store.root,
        systemPrompt: workerPrompt,
        autonomous: true,
        allowedTools: WORKER_TOOLS,
        mcpServers: { [MCP_SERVER_NAME]: mcpServer },
        ...(build.sessionId && { resumeSessionId: build.sessionId }),
        ...(model && { model }),
        ...(signal && { signal }),
      });
      for await (const event of events) {
        if (event.type === 'started')
          await store.writeTaskBuild(task.id, { ...build, sessionId: event.sessionId });
        if (event.type === 'finished') finalText = event.output;
        await trackUsage(store, config, event);
        yield { type: 'agent', task, event };
      }
    } catch (error) {
      await pauseTask(store, task.id);
      if (signal?.aborted) {
        yield { type: 'task_finished', task, outcome: 'paused' };
        return;
      }
      throw error;
    }

    const status = (await store.readPlan())?.tasks.find((t) => t.id === task.id)?.status;
    if (status === 'review') {
      yield { type: 'task_finished', task, outcome: 'review' };
    } else if (status === 'blocked') {
      yield { type: 'task_finished', task, outcome: 'blocked' };
    } else {
      // The worker stopped without handing over or asking anything: surface it
      // to the user rather than silently retrying.
      await blockTask(
        store,
        task.id,
        `I stopped before finishing this task.${finalText ? ` My last note: ${finalText}` : ''}`,
      );
      yield { type: 'task_finished', task, outcome: 'blocked' };
    }
  }
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
