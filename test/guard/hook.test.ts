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
