import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BuildEvent, build, taskBrief } from '../../src/core/builder.js';
import { blockTask, submitTask } from '../../src/core/work.js';
import { Git } from '../../src/git/git.js';
import { claim } from '../../src/util/lock.js';
import { FakeProvider } from '../fakes.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('build loop', () => {
  const project = useTempProject();
  const report = { summary: 'Done', howToVerify: ['Look'], checks: [] };

  beforeEach(async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    await project.store.writePlan({
      ...makePlan([
        makeTask({ id: 'T1', title: 'One' }),
        makeTask({ id: 'T2', title: 'Two', dependsOn: ['T1'] }),
        makeTask({ id: 'T3', title: 'Three' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
  });

  const run = async (provider: FakeProvider, signal?: AbortSignal) => {
    const events: BuildEvent[] = [];
    for await (const event of build({
      store: project.store,
      config: project.config,
      provider,
      mcpServer: { command: 'node', args: [] },
      ...(signal && { signal }),
    })) {
      events.push(event);
    }
    return events;
  };
  const statuses = async () =>
    (await project.store.readPlan())?.tasks.map((t) => `${t.id}:${t.status}`);
  const currentTask = (options: { prompt: string }) =>
    /Build (T\d+)|building (T\d+)/.exec(options.prompt)?.slice(1).find(Boolean) as string;

  it('builds every ready task, each committed on its own branch', async () => {
    const provider = new FakeProvider();
    provider.onRun = async (options) => {
      const id = currentTask(options);
      await writeFile(join(options.cwd, `${id}.js`), id);
      await submitTask(project.store, id, report);
    };
    const events = await run(provider);

    // T2 depends on T1, which is only in review, so T3 is built instead.
    expect(await statuses()).toEqual(['T1:review', 'T2:planned', 'T3:review']);
    expect(
      events
        .filter((e) => e.type === 'task_finished')
        .map((e) => e.type === 'task_finished' && e.task.id),
    ).toEqual(['T1', 'T3']);
    expect(events.at(-1)).toMatchObject({
      type: 'stopped',
      reason: expect.stringContaining('2 waiting for your review'),
      idle: true,
    });
    expect(provider.runs[0]).toMatchObject({
      autonomous: true,
      cwd: project.store.worktreeDir('T1'),
    });
    expect(provider.runs[0]?.allowedTools).toContain('mcp__dazza__submit');
    expect(provider.runs[0]?.allowedTools).not.toContain('mcp__dazza__save_plan');
  });

  it('moves on when a task is blocked', async () => {
    const provider = new FakeProvider();
    provider.onRun = async (options) => {
      const id = currentTask(options);
      if (id === 'T1') await blockTask(project.store, 'T1', 'Which database?');
      else await submitTask(project.store, id, report);
    };
    await run(provider);
    expect(await statuses()).toEqual(['T1:blocked', 'T2:planned', 'T3:review']);
  });

  it('keeps a blocked task’s half-done work out of the next task, and out of the user’s checkout', async () => {
    const provider = new FakeProvider();
    provider.onRun = async (options) => {
      const id = currentTask(options);
      if (id === 'T1') {
        await writeFile(join(options.cwd, 'stripe.js'), 'half done');
        await blockTask(project.store, 'T1', 'Stripe key?');
      } else {
        await writeFile(join(options.cwd, `${id}.js`), id);
        await submitTask(project.store, id, report);
      }
    };
    await run(provider);
    const git = new Git(project.root);
    const t3 = (await project.store.readPlan())?.tasks.find((t) => t.id === 'T3');
    expect(t3?.handoff?.filesChanged).toBe(1);
    expect(await git.isClean()).toBe(true);
    // T1's work waits in its own worktree for the answer.
    expect(existsSync(join(project.store.worktreeDir('T1'), 'stripe.js'))).toBe(true);
  });

  it('builds while the user has uncommitted changes, without touching them', async () => {
    const git = new Git(project.root);
    await git.init();
    await writeFile(join(project.root, 'mine.txt'), 'draft');
    const provider = new FakeProvider();
    provider.onRun = async (options) => {
      const id = currentTask(options);
      await writeFile(join(options.cwd, `${id}.js`), id);
      await submitTask(project.store, id, report);
    };
    await run(provider);
    expect(await statuses()).toEqual(['T1:review', 'T2:planned', 'T3:review']);
    expect(await readFile(join(project.root, 'mine.txt'), 'utf8')).toBe('draft');
    expect(existsSync(join(project.root, 'T1.js'))).toBe(false);
  });

  it('picks up a task a crashed Dazza left mid-build', async () => {
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1', title: 'One', status: 'building' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    const provider = new FakeProvider();
    provider.onRun = async () => {
      await submitTask(project.store, 'T1', report);
    };
    await run(provider);
    expect(await statuses()).toEqual(['T1:review']);
  });

  it('lets only one window build a project at a time', async () => {
    const release = await claim(project.store.builderLockFile);
    const events = await run(new FakeProvider());
    await release?.();
    expect(events).toEqual([
      { type: 'stopped', reason: 'Another Dazza window is already building this project.' },
    ]);
  });

  it('blocks a task the worker walked away from, with its last note', async () => {
    const provider = new FakeProvider([
      { type: 'finished', ok: true, output: 'I ran out of ideas', sessionId: 's', durationMs: 1 },
    ]);
    await run(provider);
    expect(await statuses()).toEqual(['T1:blocked', 'T2:planned', 'T3:blocked']);
    const note = (await project.store.readEvents()).find((e) => e.type === 'comment');
    expect(note?.message).toContain('I ran out of ideas');
  });

  it('pauses the task when stopped, keeping it for next time', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider();
    provider.onRun = async () => controller.abort();
    const events = await run(provider, controller.signal);
    expect(events.at(-1)).toMatchObject({ type: 'task_finished', outcome: 'paused' });
    expect(await statuses()).toEqual(['T1:planned', 'T2:planned', 'T3:planned']);
    expect(await project.store.readTaskBuild('T1')).toMatchObject({ branch: 'dazza/T1-one' });
  });

  it('waits for approval', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    const events = await run(new FakeProvider());
    expect(events).toEqual([
      { type: 'repo_created' },
      { type: 'stopped', reason: expect.stringContaining('approval') },
    ]);
  });
});

describe('taskBrief', () => {
  it('gives the worker the task, its criteria, subtasks, comments and scope', () => {
    const task = makeTask({
      id: 'T2',
      title: 'Login',
      acceptanceCriteria: ['Shows a form'],
      subtasks: [
        { id: 'T2.1', title: 'Form', description: 'Email and password', status: 'planned' },
      ],
    });
    const brief = taskBrief(
      makePlan([makeTask({ id: 'T1', title: 'Setup', status: 'closed' }), task]),
      task,
      '## Overview\nAn app',
      [
        {
          at: '2026-09-27T10:00:00Z',
          type: 'comment',
          actor: 'user',
          taskId: 'T2.1',
          message: 'Use magic links',
        },
      ],
      false,
    );
    expect(brief).toContain('Build T2.');
    expect(brief).toContain('- Shows a form');
    expect(brief).toContain('T2.1 [planned] Form: Email and password');
    expect(brief).toContain('User on T2.1: Use magic links');
    expect(brief).toContain('- T1 Setup');
    expect(brief).toContain('An app');
  });

  it('says what the task builds on, and which work belongs to other tasks', () => {
    const task = makeTask({ id: 'T3', title: 'Leaderboard', dependsOn: ['T1'] });
    const plan = makePlan([
      makeTask({
        id: 'T1',
        title: 'Sign-in',
        status: 'review',
        handoff: {
          summary: 'Magic links via Auth.js; `getUser()` in lib/auth.ts.',
          howToVerify: [],
          checks: [],
          screenshots: [],
          submittedAt: '2026-09-27T10:00:00Z',
        },
      }),
      task,
      makeTask({ id: 'T4', title: 'Month close' }),
    ]);
    const brief = taskBrief(plan, task, undefined, [], false);
    expect(brief).toContain('## What this builds on\n### T1: Sign-in\nMagic links via Auth.js');
    expect(brief).toContain('## Coming in other tasks (leave these alone)\n- T4 Month close');
    expect(brief).not.toContain('- T3 Leaderboard');
  });
});
