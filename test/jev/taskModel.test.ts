import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskBuild } from '../../src/core/store.js';
import { describeRoute, taskModel } from '../../src/jev/taskModel.js';
import { FakeProvider } from '../fakes.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

const MODELS = [
  { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', autonomous: true },
  { id: 'sonnet', name: 'Sonnet 5.5', description: 'Everyday', autonomous: true },
  { id: 'haiku', name: 'Haiku 4.5', description: 'Fastest', autonomous: true },
];

const answers = (fast: number, balanced: number, deep: number, risky = 0.02) => ({
  model: 'jev',
  answers: {
    tier: {
      type: 'choice',
      choice: fast >= balanced && fast >= deep ? 'fast' : balanced >= deep ? 'balanced' : 'deep',
      probabilities: { fast, balanced, deep },
      confidence: Math.max(fast, balanced, deep),
    },
    risky: { type: 'noul', noul: risky },
  },
});

/** Jev answering through a stubbed fetch, counting the calls. */
function jevAnswers(reply: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return reply();
  });
  return calls;
}

describe('taskModel', () => {
  const project = useTempProject();
  const task = makeTask({ id: 'T1', title: 'Fix a typo' });
  const build: TaskBuild = {
    branch: 'dazza/T1-fix',
    baseBranch: 'main',
    startCommit: 'abc',
    seenEvents: 0,
  };
  const choose = (provider = new FakeProvider(undefined, MODELS), b = build) =>
    taskModel({ store: project.store, config: project.config, provider, task, build: b });

  beforeEach(async () => {
    await project.store.writePlan(makePlan([task]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the /model choice, and never asks Jev, without a Jev key', async () => {
    const calls = jevAnswers(() => Response.json(answers(1, 0, 0)));
    await project.config.updateSettings({ model: 'sonnet' });
    expect((await choose()).model).toBe('sonnet');
    expect(calls).toHaveLength(0);
  });

  it('does the same with routing switched off', async () => {
    const calls = jevAnswers(() => Response.json(answers(1, 0, 0)));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
    await project.config.updateSettings({ jev: { modelRouting: false } });
    expect((await choose()).model).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('routes, records the choice on the task, and keeps it when the task resumes', async () => {
    const calls = jevAnswers(() => Response.json(answers(0.95, 0.05, 0)));
    await project.config.writeJev({ provider: 'openrouter', apiKey: 'k' });
    const first = await choose();
    expect(first.model).toBe('haiku');
    expect(first.build.route).toEqual({ model: 'haiku', sentBack: 0 });
    expect(await project.store.readTaskBuild('T1')).toMatchObject({ route: first.build.route });
    const said = (await project.store.readEvents()).filter((e) => e.type === 'routed');
    expect(said.map((e) => [e.taskId, e.message])).toEqual([
      ['T1', 'Building with Haiku 4.5: fast work (95% sure).'],
    ]);

    // Resumed: the same model, without asking again.
    expect((await choose(undefined, first.build)).model).toBe('haiku');
    expect(calls).toEqual(['https://openrouter.ai/api/v1/systemone']);
  });

  it('decides again once the work has been sent back, with a tier more after two', async () => {
    jevAnswers(() => Response.json(answers(0.95, 0.05, 0)));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
    const first = await choose();
    for (const _ of [1, 2]) {
      await project.store.appendEvent({
        at: new Date().toISOString(),
        type: 'task_rejected',
        taskId: 'T1',
        message: 'Requested changes',
      });
    }
    const again = await choose(undefined, first.build);
    expect(again.model).toBe('sonnet');
    expect(again.build.route).toEqual({ model: 'sonnet', sentBack: 2 });
  });

  it('counts work the scope check sent back, too', async () => {
    jevAnswers(() => Response.json(answers(0.95, 0.05, 0)));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
    const first = await choose();
    for (const type of ['sent_back', 'sent_back'] as const) {
      await project.store.appendEvent({
        at: new Date().toISOString(),
        type,
        taskId: 'T1',
        message: 'Sent back',
      });
    }
    expect((await choose(undefined, first.build)).model).toBe('sonnet');
  });

  it('builds with the usual model when Jev fails, and says why on the task', async () => {
    jevAnswers(() => new Response('{}', { status: 401 }));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'bad' });
    await project.config.updateSettings({ model: 'sonnet' });
    expect((await choose()).model).toBe('sonnet');
    const said = (await project.store.readEvents()).find((e) => e.type === 'routed');
    expect(said?.message).toBe(
      'Jev couldn’t say (Jev didn’t accept the TypeSafe key.), so building with Sonnet 5.5 as usual.',
    );
  });

  it('builds with the usual model when the models can’t be listed', async () => {
    const calls = jevAnswers(() => Response.json(answers(1, 0, 0)));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
    const provider = new FakeProvider(undefined, MODELS);
    provider.listModels = async () => {
      throw new Error('CLI missing');
    };
    expect((await choose(provider)).model).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('describes keeping the ceiling by its name', () => {
    expect(
      describeRoute(
        { state: 'kept', model: undefined, tier: 'deep', reason: 'deep work (80% sure)' },
        MODELS,
        undefined,
      ),
    ).toBe('Building with Default (recommended): deep work (80% sure).');
  });
});
