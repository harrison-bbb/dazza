import { describe, expect, it } from 'vitest';
import { firstMilestoneAdvice, reviewPlan } from '../../src/core/review.js';
import type { Milestone, Plan, Task } from '../../src/core/schema.js';
import { DESIGN, makeTask, plannedTask, SCOPE } from '../fixtures.js';

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

  it('wants a design direction a builder can follow, or a line saying there’s no screen', () => {
    const withDesign = (body: string) => SCOPE.replace(DESIGN, body);
    const task = [plannedTask({ id: 'T1' })];
    expect(reviewPlan(withDesign('Clean and modern.'), task)).toEqual([
      expect.stringContaining('The design direction is too thin to build from'),
    ]);
    expect(reviewPlan(SCOPE, task)).toEqual([]);
    expect(
      reviewPlan(
        withDesign('No user interface: it’s a JSON API. Errors are RFC 7807 problem details.'),
        task,
      ),
    ).toEqual([]);
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

describe('firstMilestoneAdvice', () => {
  const plan = (tasks: Task[], milestones: Milestone[]): Plan => ({
    version: 1,
    approvedAt: null,
    tasks,
    milestones,
    problems: [],
  });
  // Each builds on the last: 80 minutes before there's anything to try.
  const chain = ['T1', 'T2', 'T3', 'T4'].map((id, i) =>
    plannedTask({ id, dependsOn: i ? [`T${i}`] : [] }),
  );
  const big = { id: 'M1', title: 'Most of it', goal: 'Use it', tasks: ['T1', 'T2', 'T3'] };
  const rest = { id: 'M2', title: 'The rest', goal: 'Use it all', tasks: ['T4'] };

  it('suggests a smaller first stage when it takes over an hour, in minutes', () => {
    // An hour exactly is fine.
    expect(firstMilestoneAdvice(plan(chain, [big, rest]), 2)).toBeUndefined();
    const bigger = { ...big, tasks: ['T1', 'T2', 'T3', 'T4'] };
    expect(firstMilestoneAdvice(plan(chain, [bigger, { ...rest, tasks: [] }]), 2)).toContain(
      'M1 takes about 80 minutes to build before the user can try anything',
    );
  });

  it('never gets in the way of approving', () => {
    const bigger = { ...big, tasks: ['T1', 'T2', 'T3', 'T4'] };
    expect(reviewPlan(SCOPE, chain, [bigger, { ...rest, tasks: [] }])).toEqual([]);
  });

  it('says nothing about a one-stage plan, or one that’s under way', () => {
    const all = { ...big, tasks: ['T1', 'T2', 'T3', 'T4'] };
    expect(firstMilestoneAdvice(plan(chain, [all]), 2)).toBeUndefined();
    const started = chain.map((t) => (t.id === 'T1' ? { ...t, status: 'blocked' as const } : t));
    expect(firstMilestoneAdvice(plan(started, [all, rest]), 2)).toBeUndefined();
  });

  it('goes by how many tasks build at once', () => {
    const wide = ['T1', 'T2', 'T3', 'T4'].map((id) => plannedTask({ id }));
    const m1 = { ...big, tasks: ['T1', 'T2', 'T3', 'T4'] };
    const m2 = { ...rest, tasks: [] };
    expect(firstMilestoneAdvice(plan(wide, [m1, m2]), 2)).toBeUndefined(); // 40 minutes
    expect(firstMilestoneAdvice(plan(wide, [m1, m2]), 1)).toContain('80 minutes');
  });
});
