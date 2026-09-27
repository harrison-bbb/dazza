import { describe, expect, it } from 'vitest';
import { nextTask, progress } from '../../src/core/plan.js';
import { makePlan, makeTask } from '../fixtures.js';

describe('nextTask', () => {
  it('picks the first todo task in plan order', () => {
    const plan = makePlan([makeTask({ id: 'T1', status: 'done' }), makeTask({ id: 'T2' })]);
    expect(nextTask(plan)?.id).toBe('T2');
  });

  it('skips tasks whose dependencies are not done', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', status: 'blocked' }),
      makeTask({ id: 'T2', dependsOn: ['T1'] }),
      makeTask({ id: 'T3' }),
    ]);
    expect(nextTask(plan)?.id).toBe('T3');
  });

  it('returns undefined when nothing is ready', () => {
    const plan = makePlan([makeTask({ id: 'T1', status: 'review' })]);
    expect(nextTask(plan)).toBeUndefined();
  });
});

describe('progress', () => {
  it('counts done tasks', () => {
    const plan = makePlan([makeTask({ id: 'T1', status: 'done' }), makeTask({ id: 'T2' })]);
    expect(progress(plan)).toEqual({ done: 1, total: 2 });
  });
});
