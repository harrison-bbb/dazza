import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeTask } from '../../src/core/actions.js';
import {
  blockTask,
  landApprovedWork,
  pauseTask,
  prepareRepo,
  setSubtaskStatus,
  startTask,
  submitTask,
} from '../../src/core/work.js';
import { Git } from '../../src/git/git.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('building tasks', () => {
  const project = useTempProject();
  let git: Git;
  const write = (file: string, text = 'x') => writeFile(join(project.root, file), text);
  const task = async (id: string) =>
    (await project.store.readPlan())?.tasks.find((t) => t.id === id);
  const report = {
    summary: 'Did it',
    howToVerify: ['Run it'],
    checks: [{ name: 'Tests', passed: true }],
  };

  beforeEach(async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    git = new Git(project.root);
    await project.store.writePlan({
      ...makePlan([
        makeTask({
          id: 'T1',
          title: 'Setup',
          subtasks: [{ id: 'T1.1', title: 'Init', description: '', status: 'planned' }],
        }),
        makeTask({ id: 'T2', title: 'Feature' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
  });

  it('sets up a repository and keeps Dazza’s state out of it', async () => {
    await write('readme.md');
    expect(await prepareRepo(git)).toEqual({ ok: true, created: true });
    expect(await git.tracks('.dazza')).toBe(false);
    expect(await git.tracks('readme.md')).toBe(true);
  });

  it('refuses to start over uncommitted changes', async () => {
    await git.init();
    await write('mine.txt');
    expect(await prepareRepo(git)).toMatchObject({
      ok: false,
      message: expect.stringContaining('uncommitted'),
    });
  });

  it('builds a task on its branch, commits it and hands it over', async () => {
    await git.init();
    const base = await git.currentBranch();
    const t1 = await task('T1');
    if (!t1) throw new Error('missing');

    const build = await startTask(project.store, git, t1);
    expect(build.branch).toBe('dazza/T1-setup');
    expect(await git.currentBranch()).toBe('dazza/T1-setup');
    expect((await task('T1'))?.status).toBe('building');

    await setSubtaskStatus(project.store, 'T1.1', 'closed');
    await write('app.js');
    expect(await submitTask(project.store, git, 'T1', report)).toMatchObject({ ok: true });

    const submitted = await task('T1');
    expect(submitted?.status).toBe('review');
    expect(submitted?.subtasks[0]?.status).toBe('closed');
    expect(submitted?.handoff).toMatchObject({
      summary: 'Did it',
      branch: 'dazza/T1-setup',
      baseBranch: base,
      filesChanged: 1,
    });
    expect(await git.isClean()).toBe(true);
  });

  it('attaches screenshots to a question and to the handoff', async () => {
    await git.init();
    const shot = 'T1/home-desktop.png';
    await mkdir(join(project.store.dir, 'media', 'T1'), { recursive: true });
    await writeFile(project.store.mediaFile(shot), 'png');
    const t1 = await task('T1');
    if (!t1) throw new Error('missing');
    await startTask(project.store, git, t1);

    await blockTask(project.store, 'T1', 'Blue or green?', { images: [shot] });
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      message: 'Blue or green?',
      images: [shot],
    });

    await startTask(project.store, git, t1);
    await write('ui.html');
    await submitTask(project.store, git, 'T1', { ...report, screenshots: [shot] });
    expect((await task('T1'))?.handoff?.screenshots).toEqual([shot]);
    expect(
      await submitTask(project.store, git, 'T1', { ...report, screenshots: ['T1/nope.png'] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it('blocks with a question and pauses interrupted work', async () => {
    await git.init();
    const t1 = await task('T1');
    if (!t1) throw new Error('missing');
    await startTask(project.store, git, t1);
    await blockTask(project.store, 'T1', 'Which colour?');
    expect((await task('T1'))?.status).toBe('blocked');
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      actor: 'dazza',
      message: 'Which colour?',
    });

    const t2 = await task('T2');
    if (!t2) throw new Error('missing');
    await startTask(project.store, git, t2);
    await pauseTask(project.store, 'T2');
    expect((await task('T2'))?.status).toBe('planned');
  });

  it('lands approved work in order, even when approved out of order', async () => {
    await git.init();
    const base = await git.currentBranch();
    for (const id of ['T1', 'T2']) {
      const t = await task(id);
      if (!t) throw new Error('missing');
      await startTask(project.store, git, t);
      await write(`${id}.js`);
      await submitTask(project.store, git, id, report);
    }
    const t1Commit = (await task('T1'))?.handoff?.commit as string;
    const t2Commit = (await task('T2'))?.handoff?.commit as string;

    // T2 was built on top of T1, so approving it first mustn't land T1's unreviewed work.
    expect((await closeTask(project.store, 'T2')).message).toContain(
      'once the work before it is approved',
    );
    expect(await git.isAncestor(t1Commit, base)).toBe(false);

    // Approving T1 lands both.
    expect((await closeTask(project.store, 'T1')).message).toContain(`Merged into ${base}`);
    expect(await git.isAncestor(t2Commit, base)).toBe(true);
    expect(await landApprovedWork(project.store, git)).toEqual([]);
  });
});

describe('submitting twice', () => {
  const project = useTempProject();

  it('only hands a task over once', async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    const git = new Git(project.root);
    await git.init();
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    const t1 = (await project.store.readPlan())?.tasks[0];
    if (!t1) throw new Error('missing');
    await startTask(project.store, git, t1);
    const report = { summary: 'x', howToVerify: ['y'] };
    expect(await submitTask(project.store, git, 'T1', report)).toMatchObject({ ok: true });
    expect(await submitTask(project.store, git, 'T1', report)).toMatchObject({ ok: false });
    const submitted = (await project.store.readEvents()).filter((e) => e.type === 'task_submitted');
    expect(submitted).toHaveLength(1);
  });
});
