import { describe, expect, it } from 'vitest';
import { createBuildRenderer, renderBuildEvent, toolLine } from '../../src/chat/buildView.js';
import { makePlan, makeTask } from '../fixtures.js';

const plan = makePlan([
  makeTask({
    id: 'T1',
    title: 'Setup',
    status: 'review',
    subtasks: [{ id: 'T1.1', title: 'Init repo', description: '', status: 'closed' }],
    handoff: {
      summary: 'Set it up.',
      howToVerify: [],
      criteria: [],
      checks: [
        { name: 'Tests', passed: true },
        { name: 'Lint', passed: true },
      ],
      screenshots: [],
      filesChanged: 4,
      submittedAt: '2026-09-27T10:00:00Z',
    },
  }),
]);

describe('toolLine', () => {
  it('shows edits with a short diff, relative to the project', () => {
    const line = toolLine(
      'Edit',
      { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b\nc' },
      plan,
      '/p',
    );
    expect(line).toBe('  ⏺ Edit src/a.ts\n      - a\n      + b\n      + c');
  });

  it('caps long diffs', () => {
    const line = toolLine(
      'Edit',
      { file_path: '/p/a', old_string: '', new_string: 'x\n'.repeat(20) },
      plan,
      '/p',
    );
    expect(line).toContain('… 13 more lines');
  });

  it('shows commands, writes and subtasks closing', () => {
    expect(toolLine('Bash', { command: 'npm test' }, plan, '/p')).toBe('  ⏺ Run npm test');
    expect(toolLine('Write', { file_path: '/p/b.ts', content: '1\n2' }, plan, '/p')).toBe(
      '  ⏺ Write b.ts (2 lines)',
    );
    expect(
      toolLine('mcp__dazza__update_subtask', { id: 'T1.1', status: 'closed' }, plan, '/p'),
    ).toBe('  ✔ T1.1 Init repo');
    expect(toolLine('mcp__dazza__block', { question: 'Which DB?' }, plan, '/p')).toBe(
      '  ! Needs you: Which DB?',
    );
    expect(toolLine('TodoWrite', {}, plan, '/p')).toBeUndefined();
    // Codex reports file changes without their text: just the file.
    expect(toolLine('Edit', { file_path: '/p/a.ts' }, plan, '/p')).toBe('  ⏺ Edit a.ts');
    expect(toolLine('Delete', { file_path: '/p/old.ts' }, plan, '/p')).toBe('  ⏺ Delete old.ts');
  });
});

describe('renderBuildEvent', () => {
  const task = plan.tasks[0] as (typeof plan.tasks)[number];

  it('announces a task with its branch', () => {
    const out = renderBuildEvent(
      { type: 'task_started', task, branch: 'dazza/T1-setup', resumed: false },
      plan,
      '/p',
    );
    expect(out).toContain('Building T1 · Setup');
    expect(out).toContain('on branch dazza/T1-setup');
  });

  it('says when a usage limit pauses the build and when it resumes', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const out = renderBuildEvent(
      { type: 'waiting', task, reason: 'usage_limit', until },
      plan,
      '/p',
    );
    expect(out).toContain('Usage limit reached.');
    expect(out).toContain('T1 is paused; I’ll pick it back up at');
    expect(out).toContain('Keep Dazza open');
  });

  it('summarises a handover from the handoff', () => {
    const out = renderBuildEvent({ type: 'task_finished', task, outcome: 'review' }, plan, '/p');
    expect(out).toContain('T1 is ready for your review · 4 files changed · 2 checks passed');
    expect(out).toContain('Set it up.');
  });
});

describe('createBuildRenderer', () => {
  const task = plan.tasks[0] as (typeof plan.tasks)[number];
  const agent = (event: Parameters<typeof renderBuildEvent>[0] extends infer E ? E : never) =>
    event;

  it("shows Dazza's own actions only once they succeed", () => {
    const render = createBuildRenderer('/p');
    const call = (id: string) =>
      agent({
        type: 'agent',
        task,
        event: { type: 'tool_use', id, tool: 'mcp__dazza__submit', input: {} },
      });
    const result = (id: string, ok: boolean) =>
      agent({ type: 'agent', task, event: { type: 'tool_result', id, ok } });

    expect(render(call('a'), plan)).toBeUndefined();
    expect(render(result('a', false), plan)).toBeUndefined(); // failed attempt: nothing shown
    expect(render(call('b'), plan)).toBeUndefined();
    expect(render(result('b', true), plan)).toContain('Handing over for review');
  });

  it('shows edits and commands straight away, and hides plumbing', () => {
    const render = createBuildRenderer('/p');
    const bash = agent({
      type: 'agent',
      task,
      event: { type: 'tool_use', id: 'x', tool: 'Bash', input: { command: 'ls' } },
    });
    expect(render(bash, plan)).toBe('  ⏺ Run ls');
    const search = agent({
      type: 'agent',
      task,
      event: { type: 'tool_use', id: 'y', tool: 'ToolSearch', input: {} },
    });
    expect(render(search, plan)).toBeUndefined();
  });
});
