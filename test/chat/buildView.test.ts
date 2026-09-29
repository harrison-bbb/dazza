import { describe, expect, it } from 'vitest';
import { createBuildRenderer, renderBuildEvent, toolLine } from '../../src/chat/buildView.js';
import { stripAnsi } from '../../src/chat/style.js';
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
  it('shows an edit as the file, how much changed, and the first lines of the diff', () => {
    const line = toolLine(
      'Edit',
      { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b\nc' },
      plan,
      '/p',
    );
    expect(stripAnsi(line ?? '')).toBe(
      '  • Edit src/a.ts (+2 −1)\n      - a\n      + b\n      + c',
    );
    const long = toolLine(
      'Edit',
      { file_path: '/p/a', old_string: '', new_string: 'x\n'.repeat(20) },
      plan,
      '/p',
    );
    expect(stripAnsi(long ?? '')).toContain('… 15 more lines');
  });

  it('shows commands, writes and subtasks closing', () => {
    expect(toolLine('Bash', { command: 'npm test' }, plan, '/p')).toBe('  • Run npm test');
    expect(toolLine('Write', { file_path: '/p/b.ts', content: '1\n2' }, plan, '/p')).toBe(
      '  • Write b.ts (2 lines)',
    );
    expect(
      toolLine('mcp__dazza__update_subtask', { id: 'T1.1', status: 'closed' }, plan, '/p'),
    ).toBe('  ✔ T1.1 Init repo');
    expect(toolLine('mcp__dazza__block', { question: 'Which DB?' }, plan, '/p')).toBe(
      '  ! Needs you: Which DB?',
    );
    expect(toolLine('TodoWrite', {}, plan, '/p')).toBeUndefined();
    expect(toolLine('mcp__claude_ai_Claude_Docs__guide', {}, plan, '/p')).toBe(
      '  • Claude Docs · guide',
    );
    expect(toolLine('ToolSearch', {}, plan, '/p')).toBeUndefined();
    // Codex reports file changes without their text: just the file.
    expect(toolLine('Edit', { file_path: '/p/a.ts' }, plan, '/p')).toBe('  • Edit a.ts');
    expect(toolLine('Delete', { file_path: '/p/old.ts' }, plan, '/p')).toBe('  • Delete old.ts');
  });
});

describe('renderBuildEvent', () => {
  const task = plan.tasks[0] as (typeof plan.tasks)[number];

  it('announces a task, with how long it usually takes and how to stop it', () => {
    const out = renderBuildEvent(
      { type: 'task_started', task, branch: 'dazza/T1-setup', resumed: false },
      plan,
      '/p',
    );
    expect(out).toContain('Building T1 · Setup');
    expect(out).not.toContain('dazza/T1-setup');
    expect(stripAnsi(out ?? '')).toContain('\n  /stop to stop');
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
    const lines = stripAnsi(out ?? '').split('\n');
    // Title and summary, then how to try it, then the technical facts, then what to do.
    expect(lines.slice(1, 4)).toEqual([
      '● T1 is ready for you to try · Setup',
      '  Set it up.',
      '  Try it: /try T1, or Try it on the board',
    ]);
    expect(out).toContain('4 files changed · 2 checks passed');
    expect(out?.indexOf('Try it')).toBeLessThan(out?.indexOf('files changed') ?? 0);
    expect(out).toContain('/accept T1 to approve it');

    const withSteps = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        t.handoff
          ? { ...t, handoff: { ...t.handoff, howToVerify: ['Open the app', 'Click Save'] } }
          : t,
      ),
    };
    const steps = stripAnsi(
      renderBuildEvent({ type: 'task_finished', task, outcome: 'review' }, withSteps, '/p') ?? '',
    );
    expect(steps).toContain(
      'Try it: /try T1, or Try it on the board\n    1. Open the app\n    2. Click Save',
    );

    // Work Dazza can't start (a library, a CLI tool) gets checked, not tried.
    const library = {
      ...withSteps,
      tasks: withSteps.tasks.map((t) =>
        t.handoff ? { ...t, handoff: { ...t.handoff, runnable: false } } : t,
      ),
    };
    const check = stripAnsi(
      renderBuildEvent({ type: 'task_finished', task, outcome: 'review' }, library, '/p') ?? '',
    );
    expect(check).toContain('How to check it:\n    1. Open the app');
    expect(check).not.toContain('/try');
  });
});

describe('createBuildRenderer', () => {
  const task = plan.tasks[0] as (typeof plan.tasks)[number];
  const agent = (event: Parameters<typeof renderBuildEvent>[0] extends infer E ? E : never) =>
    event;

  it('goes quiet once a builder has asked the user something', () => {
    const render = createBuildRenderer('/p');
    const say = (text: string) =>
      render({ type: 'agent', task, event: { type: 'text', text } }, plan);
    render({ type: 'task_started', task, branch: 'b', resumed: false }, plan);
    render(
      {
        type: 'agent',
        task,
        event: {
          type: 'tool_use',
          id: 'p',
          tool: 'mcp__dazza__ask_permission',
          input: { command: 'docker run postgres', why: 'Test the migration' },
        },
      },
      plan,
    );
    expect(
      stripAnsi(
        render({ type: 'agent', task, event: { type: 'tool_result', id: 'p', ok: true } }, plan) ??
          '',
      ),
    ).toContain('Asks to run: docker run postgres · Test the migration');
    expect(say('No response requested.')).toBeUndefined();
    // Picked back up: its words show again.
    render({ type: 'task_started', task, branch: 'b', resumed: true }, plan);
    expect(say('Trying prisma dev instead.')).toContain('Trying prisma dev instead.');
  });

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

  it('folds looking around into one line before the next real step, and hides plumbing', () => {
    const render = createBuildRenderer('/p');
    const use = (id: string, tool: string, input: object) =>
      render(agent({ type: 'agent', task, event: { type: 'tool_use', id, tool, input } }), plan);
    expect(use('a', 'Read', { file_path: '/p/a.ts' })).toBeUndefined();
    expect(use('b', 'Read', { file_path: '/p/b.ts' })).toBeUndefined();
    expect(use('c', 'Bash', { command: 'ls -la && cat package.json | head' })).toBeUndefined();
    expect(use('d', 'Grep', { pattern: 'todo' })).toBeUndefined();
    expect(use('e', 'ToolSearch', {})).toBeUndefined();
    expect(stripAnsi(use('f', 'Bash', { command: 'npm test' }) ?? '')).toBe(
      '  • Read 2 files · 2 searches\n  • Run npm test',
    );
    // A command that writes isn't just looking.
    expect(stripAnsi(use('g', 'Bash', { command: 'cat a > b' }) ?? '')).toBe('  • Run cat a > b');
  });
});
