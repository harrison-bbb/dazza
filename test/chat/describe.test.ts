import { describe, expect, it } from 'vitest';
import { describeTool, farewell, greeting, NO_PLAN, planCard } from '../../src/chat/describe.js';
import { stripAnsi } from '../../src/chat/style.js';
import type { Plan } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';

const approved = (plan: Plan): Plan => ({ ...plan, approvedAt: '2026-09-27T10:00:00Z' });

describe('greeting', () => {
  it('invites a new project', () => {
    expect(greeting(undefined)).toMatch(/play back what I’ll build.*\n.*what are we building\?/s);
  });

  it('resumes an unfinished scoping conversation', () => {
    expect(greeting(undefined, { hasConversation: true })).toMatch(/where we left off/);
  });

  it('recognises an existing codebase', () => {
    expect(greeting(undefined, { codebase: 'a Go project (12 files)' })).toBe(
      'This is a Go project (12 files). What do you want to work on?',
    );
  });

  it('asks for approval of a draft', () => {
    expect(greeting(makePlan([makeTask({ id: 'T1' })]))).toMatch(
      /1 tasks, waiting on your approval/,
    );
  });

  it('reports progress and the next task', () => {
    const plan = approved(
      makePlan([makeTask({ id: 'T1', status: 'closed' }), makeTask({ id: 'T2', title: 'Auth' })]),
    );
    expect(greeting(plan)).toBe('1/2 tasks closed. Next up: T2 Auth. Run /build to start.');
  });

  it('says what’s waiting on the user', () => {
    const plan = approved(
      makePlan([
        makeTask({ id: 'T1', status: 'review', title: 'Editor' }),
        makeTask({ id: 'T2', status: 'blocked' }),
        makeTask({ id: 'T3', status: 'blocked' }),
        makeTask({ id: 'T4', status: 'building', title: 'Tags' }),
      ]),
    );
    expect(greeting(plan)).toBe(
      '0/4 tasks closed. Building T4 Tags. T1 Editor is waiting for your review. 2 tasks are blocked on you (T2, T3). /review to go through them.',
    );
  });

  it('says which milestone it’s working towards, and how much building is left', () => {
    const plan: Plan = {
      ...approved(
        makePlan([
          makeTask({ id: 'T1', status: 'closed', size: 'S' }),
          makeTask({ id: 'T2', title: 'Auth', size: 'L' }),
        ]),
      ),
      milestones: [{ id: 'M1', title: 'Sign in', goal: 'Log in', tasks: ['T1', 'T2'] }],
    };
    expect(greeting(plan)).toBe(
      '1/2 tasks closed (about 40 minutes of building left). Working towards M1 Sign in (1/2). Next up: T2 Auth. Run /build to start.',
    );
  });

  it('mentions /continue when there’s an earlier conversation, above all mid-scoping', () => {
    expect(greeting(undefined, { canContinue: true })).toMatch(
      /We were talking last time: \/continue/,
    );
    const plan = approved(makePlan([makeTask({ id: 'T1' })]));
    expect(greeting(plan, { canContinue: true })).toContain('/continue picks up the last one');
    expect(greeting(plan, { canContinue: true, hasConversation: true })).not.toContain('/continue');
  });

  it('points at the close-out report when everything is done', () => {
    const done = approved(makePlan([makeTask({ id: 'T1', status: 'closed' })]));
    expect(greeting(done)).toContain('All 1 tasks closed. The close-out report is on the board');
    expect(greeting(done)).toContain('/report');
  });

  it('speaks phone on Slack and Telegram: no terminal commands', () => {
    const plan = approved({
      ...makePlan([
        makeTask({ id: 'T1', status: 'review' }),
        makeTask({ id: 'T2', title: 'Auth' }),
      ]),
    });
    const text = greeting(plan, { remote: true });
    expect(text).toContain('Their messages are above.');
    expect(text).not.toMatch(/\/(review|build|board)/);
    expect(greeting(undefined, { remote: true })).toBe(NO_PLAN);
  });
});

describe('describeTool', () => {
  it('labels known tools', () => {
    expect(describeTool('Read', { file_path: '/p/src/app.ts' })).toBe('Reading app.ts');
    expect(describeTool('Grep', {})).toBe('Looking around the codebase');
    expect(describeTool('mcp__dazza__save_plan', {})).toBe('Writing up the plan');
  });

  it('falls back for anything else', () => {
    expect(describeTool('SomethingNew', null)).toBe('Working');
  });
});

describe('planCard', () => {
  const plan = makePlan([
    makeTask({ id: 'T1', title: 'Setup' }),
    makeTask({ id: 'T10', title: 'Launch' }),
  ]);

  it('links to the board', () => {
    expect(planCard(plan, false, 'http://localhost:4777')).toContain('http://localhost:4777');
  });

  it('lists tasks with aligned ids', () => {
    const lines = planCard(plan, false, 'http://localhost:4777').split('\n');
    expect(lines[0]).toContain('Plan saved · 2 tasks');
    expect(lines[1]).toBe('  T1   Setup');
    expect(lines[2]).toBe('  T10  Launch');
  });

  it('flags a revised approved plan for re-approval', () => {
    expect(planCard(plan, true, 'http://localhost:4777')).toContain('needs your re-approval');
  });
});

describe('farewell', () => {
  it('says what’s waiting, and how to pick the conversation back up', () => {
    const plan = makePlan([
      makeTask({ id: 'T2', title: 'Calendar', status: 'review' }),
      makeTask({ id: 'T4', title: 'Checkout', status: 'blocked' }),
    ]);
    expect(stripAnsi(farewell(plan, { conversation: true }))).toBe(
      [
        'Waiting for your review: T2 Calendar.',
        'Waiting on your answer: T4 Checkout.',
        '`dazza --continue` picks this conversation back up.',
      ].join('\n'),
    );
  });

  it('says nothing when there’s nothing to say', () => {
    expect(farewell(undefined, { conversation: false })).toBe('');
  });
});
