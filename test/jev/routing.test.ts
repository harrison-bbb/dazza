import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/schema.js';
import type { ChoiceAnswer } from '../../src/jev/client.js';
import { JevClient } from '../../src/jev/client.js';
import {
  decideModel,
  modelTier,
  ROUTING_QUESTIONS,
  routeModel,
  routingState,
  type Tier,
} from '../../src/jev/routing.js';
import type { ModelOption } from '../../src/providers/types.js';

const model = (id: string, name: string, description = '', autonomous = true): ModelOption => ({
  id,
  name,
  description,
  autonomous,
});

const CLAUDE = [
  model('default', 'Default (recommended)', 'Opus 5.5 for complex work'),
  model('opus', 'Opus 5.5', 'Most capable'),
  model('sonnet', 'Sonnet 5.5', 'Everyday tasks'),
  model('haiku', 'Haiku 4.5', 'Fastest'),
];

const tier = (fast: number, balanced: number, deep: number): ChoiceAnswer<Tier> => {
  const probabilities = { fast, balanced, deep };
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    'deep') as Tier;
  return { type: 'choice', choice, probabilities, confidence: Math.max(fast, balanced, deep) };
};
const safe = { type: 'noul', noul: 0.05 } as const;

describe('modelTier', () => {
  it('places models by family, and reads Default from what it says it is', () => {
    expect(CLAUDE.map(modelTier)).toEqual(['deep', 'deep', 'balanced', 'fast']);
    expect(modelTier(model('default', 'Default', 'Sonnet 5.5'))).toBe('balanced');
    expect(modelTier(model('claude-fable-5-1', 'Fable 5.1'))).toBe('deep');
    expect(modelTier(model('gpt-6-codex', 'GPT-6 Codex'))).toBe('deep');
    expect(modelTier(model('gpt-6-codex-mini', 'GPT-6 Codex Mini'))).toBe('fast');
    expect(modelTier(model('mystery-1', 'Mystery'))).toBeUndefined();
  });
});

describe('routeModel', () => {
  const route = (t: ChoiceAnswer<Tier>, extra: Partial<Parameters<typeof routeModel>[0]> = {}) =>
    routeModel({ tier: t, risky: safe, models: CLAUDE, chosen: undefined, ...extra });

  it('steps down to the cheapest model that’s enough', () => {
    expect(route(tier(0.9, 0.08, 0.02))).toMatchObject({ state: 'routed', model: 'haiku' });
    expect(route(tier(0.1, 0.8, 0.1))).toMatchObject({ state: 'routed', model: 'sonnet' });
  });

  it('keeps the ceiling for hard work', () => {
    expect(route(tier(0.05, 0.15, 0.8))).toEqual({
      state: 'kept',
      model: undefined,
      tier: 'deep',
      reason: 'deep work (80% sure)',
    });
  });

  it('only steps down when the stronger model is unlikely to be needed', () => {
    // Fast is likeliest, but a 40% chance it needs more is too much for Haiku.
    expect(route(tier(0.6, 0.35, 0.05))).toMatchObject({ state: 'routed', model: 'sonnet' });
    // Spread evenly: nobody knows, so the ceiling.
    expect(route(tier(0.34, 0.33, 0.33))).toMatchObject({ state: 'kept', tier: 'deep' });
  });

  it('keeps the ceiling for anything risky, however simple', () => {
    expect(route(tier(0.95, 0.05, 0), { risky: { type: 'noul', noul: 0.8 } })).toMatchObject({
      state: 'kept',
      reason: 'touches something risky',
    });
  });

  it('never goes above the model chosen with /model', () => {
    expect(route(tier(0, 0.1, 0.9), { chosen: 'sonnet' })).toMatchObject({
      state: 'kept',
      model: 'sonnet',
    });
    expect(route(tier(0.9, 0.1, 0), { chosen: 'sonnet' })).toMatchObject({
      state: 'routed',
      model: 'haiku',
    });
    expect(route(tier(0.9, 0.1, 0), { chosen: 'haiku' })).toMatchObject({
      state: 'kept',
      model: 'haiku',
    });
  });

  it('skips models that can’t build on their own, stepping up instead', () => {
    const models = CLAUDE.map((m) => (m.id === 'haiku' ? { ...m, autonomous: false } : m));
    expect(route(tier(0.95, 0.05, 0), { models })).toMatchObject({
      state: 'routed',
      model: 'sonnet',
    });
  });

  it('keeps the ceiling when there’s nothing cheaper, or its tier isn’t known', () => {
    const opusOnly = [CLAUDE[1] as ModelOption];
    expect(route(tier(0.95, 0.05, 0), { models: opusOnly })).toMatchObject({ state: 'kept' });
    const unknown = [model('mystery-1', 'Mystery'), ...CLAUDE];
    expect(route(tier(0.95, 0.05, 0), { models: unknown })).toMatchObject({ state: 'kept' });
  });

  it('gives work sent back twice one tier more', () => {
    expect(route(tier(0.9, 0.1, 0), { sentBack: 1 })).toMatchObject({ model: 'haiku' });
    expect(route(tier(0.9, 0.1, 0), { sentBack: 2 })).toMatchObject({ model: 'sonnet' });
    expect(route(tier(0.1, 0.85, 0.05), { sentBack: 2 })).toMatchObject({ state: 'kept' });
  });
});

describe('decideModel', () => {
  const task: Task = {
    id: 'T1',
    title: 'Fix the footer link',
    description: 'The privacy link points at /privcy.',
    acceptanceCriteria: ['The footer links to /privacy'],
    subtasks: [],
    dependsOn: [],
    status: 'planned',
    size: 'S',
  };

  it('sends Jev the task, never more, and routes on its answer', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        model: 'jev',
        answers: { tier: tier(0.92, 0.07, 0.01), risky: safe },
      });
    }) as typeof fetch;
    const decision = await decideModel(new JevClient({ apiKey: 'k', fetchImpl }), task, {
      models: CLAUDE,
      chosen: undefined,
    });
    expect(decision).toMatchObject({ state: 'routed', model: 'haiku' });
    expect(sent.state).toEqual(routingState(task));
    expect(sent.state).toEqual({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      size: 'S',
    });
    expect(sent.questions).toEqual(ROUTING_QUESTIONS);
  });

  it('builds on the ceiling model when Jev can’t answer', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const decision = await decideModel(new JevClient({ apiKey: 'k', fetchImpl }), task, {
      models: CLAUDE,
      chosen: 'sonnet',
    });
    expect(decision).toMatchObject({ state: 'fallback', model: 'sonnet', error: { kind: 'auth' } });
  });
});
