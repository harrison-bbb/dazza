import { describe, expect, it } from 'vitest';
import { Plan } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';

describe('Plan schema', () => {
  it('fills defaults for a minimal task', () => {
    const plan = Plan.parse({
      version: 1,
      tasks: [{ id: 'T1', title: 'Init', description: 'Set up', acceptanceCriteria: ['Runs'] }],
    });
    expect(plan.approvedAt).toBeNull();
    expect(plan.tasks[0]).toMatchObject({ status: 'planned', subtasks: [], dependsOn: [] });
  });

  it('requires at least one acceptance criterion', () => {
    const result = Plan.safeParse(makePlan([makeTask({ id: 'T1', acceptanceCriteria: [] })]));
    expect(result.success).toBe(false);
  });

  it('rejects duplicate task ids', () => {
    const result = Plan.safeParse(makePlan([makeTask({ id: 'T1' }), makeTask({ id: 'T1' })]));
    expect(result.success).toBe(false);
  });

  it('rejects dependencies on unknown tasks', () => {
    const result = Plan.safeParse(makePlan([makeTask({ id: 'T1', dependsOn: ['T9'] })]));
    expect(result.success).toBe(false);
  });

  it('rejects subtasks that do not belong to their parent', () => {
    const task = makeTask({
      id: 'T1',
      subtasks: [{ id: 'T2.1', title: 'Wrong', description: '', status: 'planned' }],
    });
    expect(Plan.safeParse(makePlan([task])).success).toBe(false);
  });
});
