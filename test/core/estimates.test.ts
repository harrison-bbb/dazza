import { describe, expect, it } from 'vitest';
import { minutesSpent, shortDuration, timeLeft } from '../../src/core/estimates.js';
import type { Event } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';

const T0 = Date.parse('2026-09-29T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const event = (type: Event['type'], taskId: string, minutes: number): Event => ({
  at: at(minutes),
  actor: 'dazza',
  type,
  taskId,
  message: type,
});

describe('time left', () => {
  it('shares independent tasks out between builders', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', size: 'M' }),
      makeTask({ id: 'T2', size: 'M' }),
      makeTask({ id: 'T3', size: 'M' }),
      makeTask({ id: 'T4', size: 'M' }),
    ]);
    const left = timeLeft(plan, [], { parallel: 2, now: T0 });
    expect(left.working).toBe(80);
    expect(left.wall).toBe(40);
  });

  it('never beats the longest chain of tasks that build on each other', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', size: 'M' }),
      makeTask({ id: 'T2', size: 'M', dependsOn: ['T1'] }),
      makeTask({ id: 'T3', size: 'L', dependsOn: ['T2'] }),
      makeTask({ id: 'T4', size: 'S' }),
    ]);
    expect(timeLeft(plan, [], { parallel: 3, now: T0 }).wall).toBe(80);
  });

  it('counts down a task being built, and says when it runs long', () => {
    const plan = makePlan([makeTask({ id: 'T1', size: 'M', status: 'building' })]);
    const events = [event('task_started', 'T1', 0)];
    expect(timeLeft(plan, events, { now: T0 + 5 * 60_000 }).perTask.T1).toBe(15);
    const late = timeLeft(plan, events, { now: T0 + 25 * 60_000 });
    expect(late.perTask.T1).toBe(1);
    expect(late.overdue).toEqual(['T1']);
  });

  it('leaves out work waiting for review, closed or in the backlog', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', size: 'L', status: 'review' }),
      makeTask({ id: 'T2', size: 'L', status: 'closed' }),
      makeTask({ id: 'T3', size: 'L', status: 'backlog' }),
      makeTask({ id: 'T4', size: 'S', dependsOn: ['T1'] }),
    ]);
    const left = timeLeft(plan, [], { now: T0 });
    expect(left.perTask).toEqual({ T4: 10 });
    expect(left.wall).toBe(10);
  });

  it('gives work sent back for changes a little time, not none', () => {
    const plan = makePlan([makeTask({ id: 'T1', size: 'S' })]); // back in the queue
    const events = [event('task_started', 'T1', 0), event('task_submitted', 'T1', 30)];
    expect(timeLeft(plan, events, { now: T0 + 60 * 60_000 }).perTask.T1).toBe(5);
  });

  it('doesn’t hang on a dependency cycle', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', size: 'S', dependsOn: ['T2'] }),
      makeTask({ id: 'T2', size: 'S', dependsOn: ['T1'] }),
    ]);
    expect(timeLeft(plan, [], { now: T0 }).wall).toBeGreaterThan(0);
  });

  it('is nothing when everything’s built', () => {
    const plan = makePlan([makeTask({ id: 'T1', size: 'S', status: 'closed' })]);
    expect(timeLeft(plan, [], { now: T0 })).toMatchObject({ working: 0, wall: 0 });
  });

  it('counts a run in progress only when asked to', () => {
    const events = [event('task_started', 'T1', 0)];
    expect(minutesSpent(events, 'T1')).toBe(0);
    expect(minutesSpent(events, 'T1', T0 + 7 * 60_000)).toBe(7);
  });

  it('reads as a short countdown', () => {
    expect(shortDuration(0.4)).toBe('under a minute');
    expect(shortDuration(12.4)).toBe('~12 min');
    expect(shortDuration(90)).toBe('~1½ hours');
  });
});
