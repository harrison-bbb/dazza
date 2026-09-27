import { describe, expect, it } from 'vitest';
import { describeTool, greeting, planCard } from '../../src/chat/describe.js';
import type { Plan } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';

const approved = (plan: Plan): Plan => ({ ...plan, approvedAt: '2026-09-27T10:00:00Z' });

describe('greeting', () => {
  it('invites a new project', () => {
    expect(greeting(undefined)).toMatch(/what we're building/);
  });

  it('resumes an unfinished scoping conversation', () => {
    expect(greeting(undefined, true)).toMatch(/where we left off/);
  });

  it('asks for approval of a draft', () => {
    expect(greeting(makePlan([makeTask({ id: 'T1' })]))).toMatch(
      /1 tasks, waiting on your approval/,
    );
  });

  it('reports progress and the next task', () => {
    const plan = approved(
      makePlan([makeTask({ id: 'T1', status: 'done' }), makeTask({ id: 'T2', title: 'Auth' })]),
    );
    expect(greeting(plan)).toBe('1/2 tasks done. Next up: T2 Auth.');
  });

  it('celebrates (quietly) when everything is done', () => {
    expect(greeting(approved(makePlan([makeTask({ id: 'T1', status: 'done' })])))).toBe(
      'All 1 tasks done. Nice.',
    );
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
