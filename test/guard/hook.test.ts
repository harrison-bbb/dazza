import { beforeEach, describe, expect, it } from 'vitest';
import { answerPermission, requestPermission } from '../../src/core/permissions.js';
import { runGuard } from '../../src/guard/hook.js';
import { notificationFor } from '../../src/notify/notification.js';
import { buildClaudeArgs } from '../../src/providers/claude.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('the guard hook', () => {
  const project = useTempProject();
  const bash = (command: string) =>
    runGuard(
      project.root,
      'worker',
      JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    );
  const decision = (output: string) =>
    output ? JSON.parse(output).hookSpecificOutput.permissionDecisionReason : 'allowed';

  beforeEach(async () => {
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1', title: 'Billing', status: 'building' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
  });

  it('approves the chat’s calls to the user’s own MCP servers, but not a builder’s', async () => {
    const call = (role: 'manager' | 'worker', tool: string) =>
      runGuard(project.root, role, JSON.stringify({ tool_name: tool, tool_input: {} }));
    const allowed = JSON.parse(await call('manager', 'mcp__claude_ai_Gmail__search_threads'));
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
    // Dazza's own tools are pre-approved already; builders never get the user's servers.
    expect(await call('manager', 'mcp__dazza__save_plan')).toBe('');
    expect(await call('worker', 'mcp__claude_ai_Gmail__search_threads')).toBe('');
  });

  it('lets normal work through without a word', async () => {
    expect(await bash('npm test')).toBe('');
  });

  it('refuses what’s never allowed, tells the agent not to work around it, and logs it', async () => {
    expect(decision(await bash('git push origin main'))).toMatch(
      /not allowed\. Dazza never pushes.*Don't try to get around this/,
    );
    const logged = (await project.store.readEvents()).at(-1);
    expect(logged).toMatchObject({ type: 'guarded', taskId: 'T1' });
    expect(logged?.message).toContain('Stopped `git push origin main`');
  });

  it('holds back what needs the user, until they allow that exact command', async () => {
    const drop = 'psql -h prod.acme.internal -c "select count(*) from invoices"';
    expect(decision(await bash(drop))).toMatch(/needs the user's OK.*ask_permission/);

    await requestPermission(project.store, 'T1', drop, 'Check the invoice count matches.');
    const note = await notificationFor(
      { type: 'task_finished', task: makeTask({ id: 'T1' }), outcome: 'blocked' },
      project.store,
    );
    expect(note).toMatchObject({ kind: 'permission', command: drop });

    expect((await answerPermission(project.store, 'T1', true)).ok).toBe(true);
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('planned');

    // Only now, and only that exact command, and only for T1.
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1', title: 'Billing', status: 'building' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    expect(await bash(drop)).toBe('');
    expect(decision(await bash(`${drop} ; `))).not.toBe('allowed');
    expect((await project.store.readEvents()).map((e) => e.message)).toContain(
      `Ran \`${drop}\` with your OK.`,
    );
  });

  it('keeps refusing after a no', async () => {
    const command = 'npm install -g typescript';
    await requestPermission(project.store, 'T1', command, 'Need tsc globally.');
    await answerPermission(project.store, 'T1', false);
    expect(decision(await bash(command))).toMatch(/needs the user's OK/);
  });

  it('with tasks building side by side, keeps each builder in its own worktree', async () => {
    await project.store.writePlan({
      ...makePlan([
        makeTask({ id: 'T1', status: 'building' }),
        makeTask({ id: 'T2', status: 'building' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    const build = { branch: 'b', baseBranch: 'main', startCommit: 'x', seenEvents: 0 };
    await project.store.writeTaskBuild('T1', { ...build, dir: '/work/T1' });
    await project.store.writeTaskBuild('T2', { ...build, dir: '/work/T2' });
    const write = (task: string, path: string) =>
      runGuard(
        project.root,
        'worker',
        JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path } }),
        task,
      );
    expect(await write('T1', '/work/T1/app.js')).toBe('');
    expect(decision(await write('T1', '/work/T2/app.js'))).toMatch(
      /outside this task.s checkout \(\/work\/T1\)/,
    );
    expect(await write('T2', '/work/T2/app.js')).toBe('');
  });

  it('fails closed when it can’t read the call', async () => {
    expect(decision(await runGuard(project.root, 'worker', 'not json'))).toMatch(
      /couldn't check this/,
    );
  });
});

describe('Claude Code runs', () => {
  it('run Dazza’s guard before every tool call, and ignore settings the repo brings', () => {
    const args = buildClaudeArgs({
      cwd: '/p',
      guard: { command: '/usr/bin/node', args: ['/opt/dazza cli.js', 'guard', '--root', '/p'] },
    });
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'user']));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
    expect(settings.hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: "/usr/bin/node '/opt/dazza cli.js' guard --root /p" }],
    });
  });
});
