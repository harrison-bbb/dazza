import { describe, expect, it } from 'vitest';
import { closeTask } from '../../src/core/actions.js';
import { humanDuration, minutesLeft, minutesSpent, sizeMinutes } from '../../src/core/estimates.js';
import {
  currentMilestone,
  isComplete,
  milestoneProgress,
  recordMilestones,
} from '../../src/core/milestones.js';
import { reportRequest } from '../../src/core/report.js';
import { type Plan, SIZE_MINUTES } from '../../src/core/schema.js';
import { milestoneNotification } from '../../src/notify/notification.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

const plan = (statuses: Record<string, string>): Plan => ({
  ...makePlan(
    Object.entries(statuses).map(([id, status]) =>
      makeTask({
        id,
        status: status as Plan['tasks'][number]['status'],
        size: 'M',
        title: `Task ${id}`,
      }),
    ),
  ),
  approvedAt: '2026-09-27T10:00:00Z',
  milestones: [
    { id: 'M1', title: 'Core', goal: 'Add and tick off todos', tasks: ['T1', 'T2'] },
    { id: 'M2', title: 'Sync', goal: 'Todos on every device', tasks: ['T3', 'T4'] },
  ],
});

describe('milestones', () => {
  const project = useTempProject();

  it('tracks progress, ignoring cancelled tasks', () => {
    const p = plan({ T1: 'closed', T2: 'cancelled', T3: 'closed', T4: 'planned' });
    expect(milestoneProgress(p).map((m) => [m.milestone.id, m.closed, m.total, m.reached])).toEqual(
      [
        ['M1', 1, 1, true],
        ['M2', 1, 2, false],
      ],
    );
    expect(currentMilestone(p)?.milestone.id).toBe('M2');
    expect(isComplete(p)).toBe(false);
    expect(isComplete(plan({ T1: 'closed', T2: 'closed', T3: 'closed', T4: 'cancelled' }))).toBe(
      true,
    );
  });

  it('records a milestone once, when its last task is closed, and says so', async () => {
    await project.store.writePlan(
      plan({ T1: 'closed', T2: 'review', T3: 'planned', T4: 'planned' }),
    );
    const closed = await closeTask(project.store, 'T2');
    expect(closed.message).toContain('That completes M1, Core.');
    expect(await recordMilestones(project.store)).toEqual([]); // already recorded
    const reached = (await project.store.readEvents()).filter(
      (e) => e.type === 'milestone_reached',
    );
    expect(reached.map((e) => e.message)).toEqual(['M1: Core']);
  });

  it('announces what a milestone delivered, and what’s next', () => {
    const p = plan({ T1: 'closed', T2: 'closed', T3: 'planned', T4: 'planned' });
    const m1 = p.milestones[0];
    if (!m1) throw new Error('missing');
    expect(milestoneNotification(p, m1, { mediaFile: (x) => x })).toMatchObject({
      kind: 'milestone',
      id: 'M1',
      goal: 'Add and tick off todos',
      tasks: ['T1 Task T1', 'T2 Task T2'],
      next: 'M2 Sync',
    });
  });
});

describe('estimates', () => {
  it('adds up what’s left, from sizes', () => {
    expect(minutesLeft(plan({ T1: 'closed', T2: 'review', T3: 'planned', T4: 'blocked' }))).toBe(
      40,
    );
    expect(humanDuration(90)).toBe('about 1½ hours');
    expect(humanDuration(45)).toBe('about 45 minutes');
    expect(humanDuration(120)).toBe('about 2 hours');
  });

  it('learns how long each size takes on this project, once two tasks of it are done', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 27, 10, minute)).toISOString();
    const took = (taskId: string, from: number, to: number) =>
      [
        { at: at(from), type: 'task_started', actor: 'dazza', taskId, message: '' },
        { at: at(to), type: 'task_submitted', actor: 'dazza', taskId, message: '' },
      ] as const;
    const project = plan({ T1: 'closed', T2: 'review', T3: 'planned', T4: 'blocked' });
    // Only one M task finished: still the default.
    expect(sizeMinutes(project, [...took('T1', 0, 8)]).M).toBe(SIZE_MINUTES.M);
    const events = [...took('T1', 0, 8), ...took('T2', 10, 22)];
    expect(sizeMinutes(project, events)).toEqual({ S: SIZE_MINUTES.S, M: 10, L: SIZE_MINUTES.L });
    expect(minutesLeft(project, events)).toBe(20);
  });

  it('measures how long the builder spent, across pauses', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 27, 10, minute)).toISOString();
    const events = [
      { at: at(0), type: 'task_started', actor: 'dazza', taskId: 'T1', message: '' },
      { at: at(10), type: 'task_moved', actor: 'dazza', taskId: 'T1', message: 'paused' },
      { at: at(30), type: 'task_started', actor: 'dazza', taskId: 'T1', message: '' },
      { at: at(45), type: 'task_submitted', actor: 'dazza', taskId: 'T1', message: '' },
    ] as const;
    expect(minutesSpent([...events], 'T1')).toBe(25);
  });
});

describe('the report request', () => {
  it('gives Dazza the facts: milestones, tasks with handoffs and timing, and the change log', () => {
    const p = plan({ T1: 'closed', T2: 'closed', T3: 'closed', T4: 'cancelled' });
    const request = reportRequest(
      p,
      [],
      '## Overview\n\n## Change log\n\n- **v2 · 2026-09-28**: Dropped T4 (T4). Why: not needed',
    );
    expect(request).toContain('Every task is closed. Write the close-out report');
    expect(request).toContain('## What you have now');
    expect(request).toContain('- M1 Core (2/2 closed): Add and tick off todos');
    expect(request).toContain('- T4 [cancelled] Task T4 (sized M (~20 min))');
    expect(request).toContain('- **v2 · 2026-09-28**: Dropped T4 (T4). Why: not needed');
  });
});
