import type { Task } from '../core/schema.js';
import type { ModelOption } from '../providers/types.js';
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  JevClient,
  JevError,
  NoulAnswer,
  NoulQuestion,
} from './client.js';

/**
 * Model routing: before a builder starts a task, Jev judges how capable a
 * model it needs, and the builder gets the cheapest model the user has that's
 * up to it. The model chosen with /model is the ceiling: routing only ever
 * steps down from it, never up, so it can't cost more than building did before.
 */

export const TIERS = ['fast', 'balanced', 'deep'] as const;
export type Tier = (typeof TIERS)[number];

export const ROUTING_QUESTIONS = {
  tier: {
    type: 'choice',
    instructions:
      'A coding agent will build this task in an existing codebase. How capable a model does it need to get it right first time?',
    criteria: {
      fast: 'Mechanical: copy, config or rename changes, or small isolated edits that follow an obvious pattern',
      balanced:
        'Ordinary engineering: a feature or fix across a few files, with clear requirements',
      deep: 'Hard: architecture, tricky debugging, concurrency, performance, data migrations, or requirements that need judgment',
    },
  } satisfies ChoiceQuestion<Tier>,
  risky: {
    type: 'noul',
    instructions:
      'Does this task touch money, payments, credentials, authentication, production data, or anything hard to undo?',
    criteria: { true: 'It touches one of these', false: 'It touches none of these' },
  } satisfies NoulQuestion,
};

/** What Jev reads about a task: what it asks for, never the code. */
export function routingState(task: Task): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    ...(task.size && { size: task.size }),
    ...(task.subtasks.length > 0 && { subtasks: task.subtasks.map((s) => s.title) }),
  };
}

/**
 * Step down to a tier only when the chance the task needs more than it is at
 * most this. Jev's probabilities are calibrated, so this reads as "one task in
 * four or fewer of these would have wanted the stronger model".
 */
export const MAX_UNDERPOWER_RISK = 0.25;
/** Above this, a task is treated as risky and keeps the ceiling model. */
export const RISKY_ABOVE = 0.5;
/** Sent back this many times, a task gets one tier more than Jev said. */
export const STEP_UP_AFTER = 2;

/** The tier a model is, from its family, or undefined if Dazza can't tell. */
export function modelTier(model: ModelOption): Tier | undefined {
  // "Default" names its model in the description, e.g. "Opus 5.5".
  const text = `${model.id} ${model.name} ${/default/i.test(model.id) ? model.description : ''}`;
  if (/haiku|\b(mini|nano|lite|flash|spark)\b|-(mini|nano|lite|flash|spark)\b/i.test(text)) {
    return 'fast';
  }
  if (/sonnet/i.test(text)) return 'balanced';
  if (/opus|fable|codex|gpt/i.test(text)) return 'deep';
  return undefined;
}

export type RouteDecision =
  /** A cheaper model than the ceiling. */
  | { state: 'routed'; model: string; tier: Tier; reason: string }
  /** The ceiling model, as without routing. `model` is undefined for the provider's default. */
  | { state: 'kept'; model: string | undefined; tier: Tier; reason: string }
  /** Jev couldn't answer: the ceiling model, as without routing. */
  | { state: 'fallback'; model: string | undefined; reason: string };

export interface RouteInput {
  tier: ChoiceAnswer<Tier>;
  risky: NoulAnswer;
  /** The models the account has, in the provider's order. */
  models: ModelOption[];
  /** The /model choice; undefined is the provider's default (the first listed). */
  chosen: string | undefined;
  /** How many times this task's work has been sent back. */
  sentBack?: number;
}

/** Pick the model for a task from Jev's answers. Pure, so every rule is tested on its own. */
export function routeModel(input: RouteInput): RouteDecision {
  const { tier, risky, models, chosen } = input;
  const ceiling = models.find((m) => m.id === chosen) ?? models[0];
  const ceilingTier = ceiling && modelTier(ceiling);
  const keep = (needed: Tier, reason: string): RouteDecision => ({
    state: 'kept',
    model: chosen,
    tier: needed,
    reason,
  });

  if (risky.noul > RISKY_ABOVE) return keep('deep', 'touches something risky');
  let needed = lowestSafeTier(tier.probabilities);
  if ((input.sentBack ?? 0) >= STEP_UP_AFTER) {
    needed = TIERS[Math.min(TIERS.indexOf(needed) + 1, TIERS.length - 1)] ?? needed;
  }
  const why = `${needed} work (${Math.round(tier.confidence * 100)}% sure)`;
  if (!ceiling || !ceilingTier) return keep(needed, `${why}; your model’s tier isn’t known`);
  if (rank(needed) >= rank(ceilingTier)) return keep(needed, why);

  // The cheapest tier that's enough, stepping up while the account has none of it.
  for (let r = rank(needed); r < rank(ceilingTier); r++) {
    const option = models.find((m) => m.autonomous && modelTier(m) === TIERS[r]);
    if (option) {
      return { state: 'routed', model: option.id, tier: needed, reason: why };
    }
  }
  return keep(needed, `${why}; no cheaper model that can build`);
}

/** The lowest tier the task is unlikely to need more than. */
function lowestSafeTier(probabilities: Record<Tier, number>): Tier {
  for (const [i, tier] of TIERS.entries()) {
    const needsMore = TIERS.slice(i + 1).reduce((sum, t) => sum + (probabilities[t] ?? 0), 0);
    if (needsMore <= MAX_UNDERPOWER_RISK) return tier;
  }
  return 'deep';
}

const rank = (tier: Tier) => TIERS.indexOf(tier);

/**
 * Ask Jev about a task and pick its model. Never fails: when Jev can't answer,
 * the task builds on the ceiling model as it would have without routing.
 */
export async function decideModel(
  jev: JevClient,
  task: Task,
  options: Omit<RouteInput, 'tier' | 'risky'>,
  signal?: AbortSignal,
): Promise<RouteDecision & { error?: JevError }> {
  const result = await jev.ask(routingState(task), ROUTING_QUESTIONS, signal);
  if (!result.ok) {
    return {
      state: 'fallback',
      model: options.chosen,
      reason: `Jev couldn’t say (${result.error.message})`,
      error: result.error,
    };
  }
  return routeModel({ ...options, ...result.answers });
}
