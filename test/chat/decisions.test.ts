import { describe, expect, it } from 'vitest';
import { decisionsIn } from '../../src/chat/decisions.js';
import { makePlan, makeTask } from '../fixtures.js';

describe('decisionsIn', () => {
  it('finds commands asking for an OK and work to review, each with its own key', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', status: 'blocked' }),
      makeTask({ id: 'T2', status: 'blocked' }),
      makeTask({
        id: 'T3',
        status: 'review',
        handoff: {
          summary: 's',
          howToVerify: [],
          criteria: [],
          checks: [],
          screenshots: [],
          submittedAt: '2026-10-02T09:00:00.000Z',
        },
      }),
      makeTask({ id: 'T4', status: 'planned' }),
    ]);
    const found = decisionsIn(plan, { T2: { command: 'psql prod', why: 'migrate' } });
    expect(found.map((d) => [d.kind, d.key])).toEqual([
      ['permission', 'allow:T2:psql prod'],
      ['review', 'review:T3:2026-10-02T09:00:00.000Z'],
    ]);
    expect(decisionsIn(undefined, {})).toEqual([]);
  });
});
