import { describe, expect, it } from 'vitest';
import { reviewPlan } from '../../src/core/review.js';
import { makeTask, plannedTask, SCOPE } from '../fixtures.js';

describe('reviewPlan', () => {
  it('passes a plan written to the standard', () => {
    expect(reviewPlan(SCOPE, [plannedTask({ id: 'T1' })])).toEqual([]);
  });

  it('matches headings loosely: case, spacing and straight apostrophes', () => {
    const scope = SCOPE.replace('## What I’ll need from you', "##  what I'll NEED from you");
    expect(reviewPlan(scope, [plannedTask({ id: 'T1' })])).toEqual([]);
  });

  it('leaves finished work alone, and names every thin part of the rest', () => {
    const thin = makeTask({
      id: 'T2',
      acceptanceCriteria: ['Works'],
      subtasks: [{ id: 'T2.1', title: 'Form', description: 'Build the form', status: 'planned' }],
    });
    const problems = reviewPlan(SCOPE, [makeTask({ id: 'T1', status: 'closed' }), thin]);
    expect(problems.some((p) => p.startsWith('T1'))).toBe(false);
    expect(problems).toEqual([
      expect.stringContaining('T2: the description is'),
      expect.stringContaining('T2: has 1 subtasks'),
      'T2: give it a size (S, M or L).',
      expect.stringContaining('T2: add acceptance criteria'),
      expect.stringContaining('T2.1: the description is too short'),
    ]);
  });

  it('asks bigger plans for milestones that cover the planned work', () => {
    const tasks = ['T1', 'T2', 'T3', 'T4'].map((id) => plannedTask({ id }));
    expect(reviewPlan(SCOPE, tasks)).toContain(
      'Group the tasks into milestones: stages the user can see and try.',
    );
    const m1 = { id: 'M1', title: 'Core', goal: 'Add todos', tasks: ['T1', 'T2', 'T3'] };
    expect(reviewPlan(SCOPE, tasks, [m1])).toContain('Put T4 in a milestone.');
    expect(reviewPlan(SCOPE, tasks, [{ ...m1, tasks: ['T1', 'T2', 'T3', 'T4'] }])).toEqual([]);
  });
});
