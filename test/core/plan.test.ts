import { describe, expect, it } from 'vitest';
import { approve, carryOverProgress, nextTask, progress } from '../../src/core/plan.js';
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

describe('approve', () => {
  it('stamps the approval time once', () => {
    const plan = makePlan([makeTask({ id: 'T1' })]);
    const first = approve(plan, new Date('2026-09-27T10:00:00Z'));
    const second = approve(first, new Date('2026-09-28T10:00:00Z'));
    expect(first.approvedAt).toBe('2026-09-27T10:00:00.000Z');
    expect(second).toBe(first);
  });
});

describe('carryOverProgress', () => {
  it('ignores planner-supplied status and keeps real progress', () => {
    const current = makePlan([
      makeTask({
        id: 'T1',
        status: 'in_progress',
        subtasks: [{ id: 'T1.1', title: 'a', done: true }],
      }),
    ]);
    const revised = [
      makeTask({ id: 'T1', subtasks: [{ id: 'T1.1', title: 'a', done: false }] }),
      makeTask({ id: 'T2', status: 'done' }),
    ];
    const tasks = carryOverProgress(current, revised);

    expect(tasks).not.toBeTypeOf('string');
    if (typeof tasks === 'string') return;
    expect(tasks.map((t) => t.status)).toEqual(['in_progress', 'todo']);
    expect(tasks[0]?.subtasks[0]?.done).toBe(true);
  });

  it('allows removing tasks that have not started', () => {
    const current = makePlan([makeTask({ id: 'T1' }), makeTask({ id: 'T2' })]);
    expect(carryOverProgress(current, [makeTask({ id: 'T1' })])).toHaveLength(1);
  });

  it('rejects removing started tasks', () => {
    const current = makePlan([makeTask({ id: 'T1', status: 'review' })]);
    expect(carryOverProgress(current, [])).toMatch(/T1 \(review\)/);
  });
});
