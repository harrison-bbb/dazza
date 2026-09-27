import { describe, expect, it } from 'vitest';
import {
  approve,
  carryOverProgress,
  currentTask,
  findItem,
  nextTask,
  progress,
  withStatus,
} from '../../src/core/plan.js';
import { makePlan, makeTask } from '../fixtures.js';

const subtask = (id: string, status: 'planned' | 'closed' = 'planned') => ({
  id,
  title: `Subtask ${id}`,
  description: '',
  status,
});

describe('nextTask', () => {
  it('picks the first planned task in plan order', () => {
    const plan = makePlan([makeTask({ id: 'T1', status: 'closed' }), makeTask({ id: 'T2' })]);
    expect(nextTask(plan)?.id).toBe('T2');
  });

  it('skips tasks whose dependencies are not closed', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', status: 'review' }),
      makeTask({ id: 'T2', dependsOn: ['T1'] }),
      makeTask({ id: 'T3' }),
    ]);
    expect(nextTask(plan)?.id).toBe('T3');
  });

  it('never picks backlog work', () => {
    expect(nextTask(makePlan([makeTask({ id: 'T1', status: 'backlog' })]))).toBeUndefined();
  });
});

describe('currentTask', () => {
  it('finds the task being built', () => {
    const plan = makePlan([makeTask({ id: 'T1' }), makeTask({ id: 'T2', status: 'building' })]);
    expect(currentTask(plan)?.id).toBe('T2');
  });
});

describe('progress', () => {
  it('counts closed tasks and leaves cancelled ones out of scope', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', status: 'closed' }),
      makeTask({ id: 'T2' }),
      makeTask({ id: 'T3', status: 'cancelled' }),
    ]);
    expect(progress(plan)).toEqual({ closed: 1, total: 2 });
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

describe('findItem and withStatus', () => {
  const plan = makePlan([makeTask({ id: 'T1', subtasks: [subtask('T1.1')] })]);

  it('finds tasks and subtasks with their parent', () => {
    expect(findItem(plan, 'T1')?.subtask).toBeUndefined();
    expect(findItem(plan, 'T1.1')).toMatchObject({ task: { id: 'T1' }, subtask: { id: 'T1.1' } });
    expect(findItem(plan, 'T9')).toBeUndefined();
  });

  it('updates a task or subtask status without mutating', () => {
    expect(withStatus(plan, 'T1', 'building').tasks[0]?.status).toBe('building');
    expect(withStatus(plan, 'T1.1', 'closed').tasks[0]?.subtasks[0]?.status).toBe('closed');
    expect(plan.tasks[0]?.status).toBe('planned');
  });
});

describe('carryOverProgress', () => {
  it('keeps real progress and ignores statuses the planner made up', () => {
    const current = makePlan([
      makeTask({ id: 'T1', status: 'building', subtasks: [subtask('T1.1', 'closed')] }),
    ]);
    const revised = [
      makeTask({ id: 'T1', subtasks: [subtask('T1.1')] }),
      makeTask({ id: 'T2', status: 'closed' }),
    ];
    const tasks = carryOverProgress(current, revised);

    if (typeof tasks === 'string') throw new Error(tasks);
    expect(tasks.map((t) => t.status)).toEqual(['building', 'planned']);
    expect(tasks[0]?.subtasks[0]?.status).toBe('closed');
  });

  it('lets the planner file new work in the backlog', () => {
    const tasks = carryOverProgress(undefined, [makeTask({ id: 'T1', status: 'backlog' })]);
    if (typeof tasks === 'string') throw new Error(tasks);
    expect(tasks[0]?.status).toBe('backlog');
  });

  it('allows removing work that has not started or is finished', () => {
    const current = makePlan([
      makeTask({ id: 'T1' }),
      makeTask({ id: 'T2', status: 'backlog' }),
      makeTask({ id: 'T3', status: 'cancelled' }),
    ]);
    expect(carryOverProgress(current, [])).toEqual([]);
  });

  it('rejects removing work in flight', () => {
    const current = makePlan([makeTask({ id: 'T1', status: 'review' })]);
    expect(carryOverProgress(current, [])).toMatch(/T1 \(review\)/);
  });
});
