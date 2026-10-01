import type { Config } from '../core/config.js';
import type { Task } from '../core/schema.js';
import type { Store, TaskBuild } from '../core/store.js';
import type { AgentProvider, ModelOption } from '../providers/types.js';
import { jevOn } from './features.js';
import { jevClient } from './providers.js';
import { decideModel, type RouteDecision } from './routing.js';

/**
 * The model a builder uses for a task, and its build record with the choice in
 * it. Without Jev, or with routing off, it's the one chosen with /model, as always. With it, Jev decides once per task
 * (and again after the work has been sent back), and the choice is kept in the
 * task's build record so a resumed task carries on with the same model.
 */
export async function taskModel(options: {
  store: Store;
  config: Config;
  provider: AgentProvider;
  task: Task;
  build: TaskBuild;
  signal?: AbortSignal;
}): Promise<{ model: string | undefined; build: TaskBuild }> {
  const { store, config, provider, task, build, signal } = options;
  const settings = await config.readSettings();
  const chosen = settings.model;
  if (!jevOn(settings, 'modelRouting')) return { model: chosen, build };
  const link = await config.readJev();
  if (!link) return { model: chosen, build };

  const sentBack = (await store.readEvents()).filter(
    (e) => e.taskId === task.id && e.type === 'task_rejected',
  ).length;
  if (build.route && build.route.sentBack === sentBack) {
    return { model: build.route.model ?? chosen, build };
  }

  const models = await modelsOf(provider);
  if (!models) return { model: chosen, build };
  const decision = await decideModel(jevClient(link), task, { models, chosen, sentBack }, signal);
  // Stopped while Jev was asked: nothing was decided, so nothing is kept.
  if (signal?.aborted) return { model: chosen, build };
  const model = decision.state === 'routed' ? decision.model : undefined;
  const routed = { ...build, route: { ...(model && { model }), sentBack } };
  await store.writeTaskBuild(task.id, routed);
  await store.appendEvent({
    at: new Date().toISOString(),
    type: 'routed',
    taskId: task.id,
    message: describeRoute(decision, models, chosen),
  });
  return { model: model ?? chosen, build: routed };
}

/** What the task's timeline says about the choice. */
export function describeRoute(
  decision: RouteDecision,
  models: ModelOption[],
  chosen: string | undefined,
): string {
  const name = (id: string | undefined) =>
    (models.find((m) => m.id === id) ?? (id ? undefined : models[0]))?.name ?? id ?? 'the default';
  if (decision.state === 'fallback') {
    return `${decision.reason}, so building with ${name(chosen)} as usual.`;
  }
  if (decision.state === 'routed') {
    return `Building with ${name(decision.model)}: ${decision.reason}.`;
  }
  return `Building with ${name(chosen)}: ${decision.reason}.`;
}

/** Each provider's models, asked once per Dazza run: listing them starts the agent CLI. */
const listed = new WeakMap<AgentProvider, Promise<ModelOption[]>>();

async function modelsOf(provider: AgentProvider): Promise<ModelOption[] | undefined> {
  let models = listed.get(provider);
  if (!models) {
    models = provider.listModels();
    listed.set(provider, models);
  }
  try {
    return await models;
  } catch {
    listed.delete(provider);
    return undefined;
  }
}
