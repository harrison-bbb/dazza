import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelTask, closeTask } from '../../src/core/actions.js';
import type { Task } from '../../src/core/schema.js';
import {
  blockTask,
  landApprovedWork,
  prepareRepo,
  recoverInterruptedWork,
  redoTask,
  setSubtaskStatus,
  startTask,
  submitTask,
} from '../../src/core/work.js';
import { Git } from '../../src/git/git.js';
import { makePlan, makeTask, workReport } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

const report = { ...workReport, summary: 'Did it', checks: [{ name: 'Tests', passed: true }] };

describe('building tasks', () => {
  const project = useTempProject();
  let git: Git;
  const write = (file: string, text = 'x') => writeFile(join(project.root, file), text);
  const task = async (id: string) =>
    (await project.store.readPlan())?.tasks.find((t) => t.id === id) as Task;
  /** Build a task in its worktree: write files there, then hand it over. */
  const buildTask = async (id: string, files: Record<string, string> = { [`${id}.js`]: id }) => {
    const build = await startTask(project.store, git, await task(id));
    for (const [file, text] of Object.entries(files)) {
      await writeFile(join(build.dir as string, file), text);
    }
    expect(await submitTask(project.store, id, report)).toMatchObject({ ok: true });
    return build;
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
        makeTask({ id: 'T2', title: 'Feature', dependsOn: ['T1'] }),
        makeTask({ id: 'T3', title: 'Other' }),
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

  it('builds over the user’s uncommitted changes, and gives an empty repo a first commit', async () => {
    await git.init();
    await write('mine.txt');
    expect(await prepareRepo(git)).toEqual({ ok: true, created: false });

    const empty = new Git(join(project.root, 'empty'));
    await mkdir(empty.root);
    await new Git(empty.root).init(); // init commits; make a truly empty one instead
    await import('node:child_process').then(({ execFileSync }) => {
      execFileSync('git', ['-C', empty.root, 'update-ref', '-d', 'HEAD']);
    });
    expect(await empty.hasCommits()).toBe(false);
    expect(await prepareRepo(empty)).toMatchObject({ ok: true });
    expect(await empty.hasCommits()).toBe(true);
  });

  it('builds a task in its own worktree, leaving the user’s checkout alone', async () => {
    await git.init();
    const base = await git.currentBranch();
    await write('mine.txt', 'my draft');

    const build = await startTask(project.store, git, await task('T1'));
    expect(build).toMatchObject({
      branch: 'dazza/T1-setup',
      baseBranch: base,
      dir: project.store.worktreeDir('T1'),
    });
    expect(await new Git(build.dir as string).currentBranch()).toBe('dazza/T1-setup');
    expect(await git.currentBranch()).toBe(base);
    expect((await task('T1')).status).toBe('building');

    await setSubtaskStatus(project.store, 'T1.1', 'closed');
    await writeFile(join(build.dir as string, 'app.js'), 'x');
    expect(await submitTask(project.store, 'T1', report)).toMatchObject({ ok: true });

    const submitted = await task('T1');
    expect(submitted.status).toBe('review');
    expect(submitted.subtasks[0]?.status).toBe('closed');
    expect(submitted.handoff).toMatchObject({
      summary: 'Did it',
      branch: 'dazza/T1-setup',
      baseBranch: base,
      filesChanged: 1,
    });
    // The user's draft is still theirs, uncommitted, and the task's file isn't in their checkout.
    expect(await readFile(join(project.root, 'mine.txt'), 'utf8')).toBe('my draft');
    expect(existsSync(join(project.root, 'app.js'))).toBe(false);
  });

  it('won’t hand over secrets, local-only files, or a partial report on the criteria', async () => {
    await git.init();
    const build = await startTask(project.store, git, await task('T1'));
    const dir = build.dir as string;
    await writeFile(join(dir, 'pay.js'), `const key = 'sk_live_${'a'.repeat(24)}';`);
    await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://prod');
    await writeFile(join(dir, 'server.log'), 'GET / 200');
    await writeFile(join(dir, '.env.example'), 'DATABASE_URL=');

    const refused = await submitTask(project.store, 'T1', report);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('pay.js contains a live Stripe key');
    expect(refused.message).toContain('.env is an environment file with real settings');
    expect(refused.message).toContain('server.log is a log file');
    expect(refused.message).not.toContain('.env.example');
    expect((await task('T1')).status).toBe('building');

    await writeFile(join(dir, 'pay.js'), 'const key = process.env.STRIPE_SECRET_KEY;');
    await writeFile(join(dir, '.gitignore'), '.env\n*.log\n');
    expect(await submitTask(project.store, 'T1', { ...report, criteria: [] })).toMatchObject({
      ok: false,
    });
    expect(await submitTask(project.store, 'T1', report)).toMatchObject({ ok: true });
    expect((await task('T1')).handoff?.criteria).toEqual(report.criteria);
  });

  it('keeps the summary plain and short, with the technical detail apart', async () => {
    await git.init();
    await startTask(project.store, git, await task('T1'));
    const refused = await submitTask(project.store, 'T1', { ...report, summary: 'x'.repeat(501) });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('move the technical detail to details');

    const details = '- Prisma 7 with the pg adapter\n- Migration written, not yet run';
    expect(
      await submitTask(project.store, 'T1', { ...report, summary: 'You can sign in.', details }),
    ).toMatchObject({ ok: true });
    expect((await task('T1')).handoff).toMatchObject({ summary: 'You can sign in.', details });
  });

  it('won’t hand over unfinished work: TODOs, stubs, lorem ipsum', async () => {
    await git.init();
    const build = await startTask(project.store, git, await task('T1'));
    const dir = build.dir as string;
    await writeFile(join(dir, 'sync.js'), 'export function sync() {\n  // TODO: handle errors\n}');
    await writeFile(
      join(dir, 'export.ts'),
      "export const run = () => { throw new Error('Not implemented'); };",
    );
    await writeFile(join(dir, 'copy.js'), "export const about = 'Lorem ipsum dolor sit amet';");
    await writeFile(
      join(dir, 'nav.js'),
      "export const addTrade = { label: 'Add trade', title: 'Coming soon' };",
    );
    // Not unfinished: a to-do app's own words, and plans in a README.
    await writeFile(join(dir, 'board.js'), "export const COLUMNS = ['TODO', 'DOING', 'DONE'];");
    await writeFile(join(dir, 'NOTES.md'), '- TODO: dark mode, later');

    const refused = await submitTask(project.store, 'T1', report);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('sync.js still has a TODO');
    expect(refused.message).toContain('export.ts still has a stub that isn’t implemented');
    expect(refused.message).toContain('copy.js still has placeholder text (lorem ipsum)');
    expect(refused.message).toContain('nav.js still has something marked “coming soon”');
    expect(refused.message).not.toContain('board.js');
    expect(refused.message).not.toContain('NOTES.md');

    await writeFile(join(dir, 'sync.js'), 'export function sync() {\n  return retry(3);\n}');
    await writeFile(join(dir, 'export.ts'), 'export const run = () => exportCsv();');
    await writeFile(join(dir, 'copy.js'), "export const about = 'Track every walk in one place.';");
    await rm(join(dir, 'nav.js'));
    expect(await submitTask(project.store, 'T1', report)).toMatchObject({ ok: true });
  });

  it('won’t hand over template leftovers nothing uses', async () => {
    await git.init();
    const build = await startTask(project.store, git, await task('T1'));
    const dir = build.dir as string;
    await mkdir(join(dir, 'public'), { recursive: true });
    await writeFile(join(dir, 'public', 'next.svg'), '<svg/>');
    await writeFile(join(dir, 'public', 'vite.svg'), '<svg/>');
    await writeFile(join(dir, 'app.js'), "document.querySelector('link').href = '/vite.svg';");

    const refused = await submitTask(project.store, 'T1', report);
    expect(refused.message).toContain('public/next.svg is a placeholder from the project template');
    expect(refused.message).not.toContain('vite.svg'); // in use
    await rm(join(dir, 'public', 'next.svg'));
    expect(await submitTask(project.store, 'T1', report)).toMatchObject({ ok: true });
  });

  it('wants screenshots of work that changes what the user sees', async () => {
    await git.init();
    const build = await startTask(project.store, git, await task('T1'));
    await writeFile(join(build.dir as string, 'Page.tsx'), 'export const Page = () => null;');

    const refused = await submitTask(project.store, 'T1', report);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('you changed what the user sees (Page.tsx)');
    expect(
      await submitTask(project.store, 'T1', {
        ...report,
        noScreenshots: 'The page needs a login I can’t create.',
      }),
    ).toMatchObject({ ok: true });
  });

  it('keeps what a builder learned, for the builders after it', async () => {
    await git.init();
    const build = await startTask(project.store, git, await task('T1'));
    await writeFile(join(build.dir as string, 'a.js'), 'x');
    await submitTask(project.store, 'T1', {
      ...report,
      notes: '- Components live in src/ui\n- Run tests with pnpm test',
    });
    expect(await project.store.readNotes()).toBe(
      '# Project notes\n\n## T1: Setup\n\n- Components live in src/ui\n- Run tests with pnpm test\n',
    );
    expect((await task('T1')).handoff).not.toHaveProperty('notes');
  });

  it('starts a task over from scratch, throwing its work away', async () => {
    await git.init();
    const first = await buildTask('T1', { 'bad.js': 'a terrible attempt' });
    await setSubtaskStatus(project.store, 'T1.1', 'closed');

    const redone = await redoTask(project.store, git, 'T1', 'Use the existing router');
    expect(redone.ok).toBe(true);
    const t1 = await task('T1');
    expect(t1.status).toBe('planned');
    expect(t1.handoff).toBeUndefined();
    expect(t1.subtasks[0]?.status).toBe('planned');
    expect(existsSync(first.dir as string)).toBe(false);
    expect(await git.branchExists(first.branch)).toBe(false);
    expect(await project.store.readTaskBuild('T1')).toBeUndefined();
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      actor: 'user',
      message: 'Starting over. Use the existing router',
    });

    // The next attempt starts fresh: none of the old work.
    const again = await startTask(project.store, git, await task('T1'));
    expect(existsSync(join(again.dir as string, 'bad.js'))).toBe(false);
  });

  it('won’t start over work that’s being built, or already merged', async () => {
    await git.init();
    await startTask(project.store, git, await task('T1'));
    expect((await redoTask(project.store, git, 'T1')).message).toContain('/stop first');
    await submitTask(project.store, 'T1', report);
    await closeTask(project.store, 'T1');
    expect((await redoTask(project.store, git, 'T1')).message).toContain('approved and merged');
  });

  it('resumes where it left off, and recreates a worktree that was deleted', async () => {
    await git.init();
    const first = await startTask(project.store, git, await task('T1'));
    await writeFile(join(first.dir as string, 'wip.js'), 'half');
    await blockTask(project.store, 'T1', 'Which colour?');

    const again = await startTask(project.store, git, await task('T1'));
    expect(again.dir).toBe(first.dir);
    expect(existsSync(join(again.dir as string, 'wip.js'))).toBe(true);

    await git.removeWorktree(again.dir as string); // say the user cleared it out
    const recreated = await startTask(project.store, git, await task('T1'));
    expect(await new Git(recreated.dir as string).currentBranch()).toBe('dazza/T1-setup');
  });

  it('attaches screenshots to a question and to the handoff', async () => {
    await git.init();
    const shot = 'T1/home-desktop.png';
    await mkdir(join(project.store.dir, 'media', 'T1'), { recursive: true });
    await writeFile(project.store.mediaFile(shot), 'png');
    await startTask(project.store, git, await task('T1'));

    await blockTask(project.store, 'T1', 'Blue or green?', { images: [shot] });
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      message: 'Blue or green?',
      images: [shot],
    });

    await startTask(project.store, git, await task('T1'));
    expect(
      await submitTask(project.store, 'T1', { ...report, screenshots: ['T1/nope.png'] }),
    ).toMatchObject({ ok: false });
    await submitTask(project.store, 'T1', { ...report, screenshots: [shot] });
    expect((await task('T1')).handoff?.screenshots).toEqual([shot]);
  });

  it('puts work a crashed Dazza left mid-build back in the queue', async () => {
    await git.init();
    await startTask(project.store, git, await task('T1'));
    expect(await recoverInterruptedWork(project.store)).toEqual(['T1']);
    expect((await task('T1')).status).toBe('planned');
    expect(await recoverInterruptedWork(project.store)).toEqual([]);
  });

  it('lands approved work on the user’s branch, and removes its worktree', async () => {
    await git.init();
    const base = await git.currentBranch();
    const build = await buildTask('T1');

    const closed = await closeTask(project.store, 'T1');
    expect(closed.message).toContain(`Merged into ${base}`);
    expect(existsSync(join(project.root, 'T1.js'))).toBe(true);
    expect(existsSync(build.dir as string)).toBe(false);
    expect(await git.branchExists(build.branch)).toBe(true);
  });

  it('merges when the user’s branch has moved on', async () => {
    await git.init();
    await buildTask('T1');
    await write('theirs.js');
    await git.commitAll('Their own work');

    expect((await closeTask(project.store, 'T1')).message).toContain('Merged into');
    expect(existsSync(join(project.root, 'T1.js'))).toBe(true);
    expect(existsSync(join(project.root, 'theirs.js'))).toBe(true);
  });

  it('lands on a branch the user doesn’t have checked out, merging off to the side', async () => {
    await git.init();
    const base = await git.currentBranch();
    await buildTask('T1');
    await write('theirs.js');
    await git.commitAll('Their own work'); // base has moved on: a merge, not a fast-forward
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', project.root, 'checkout', '-q', '-b', 'elsewhere']);
    await write('draft.txt'); // uncommitted, on a different branch: irrelevant to landing

    expect((await closeTask(project.store, 'T1')).message).toContain(`Merged into ${base}`);
    const landed = execFileSync('git', ['-C', project.root, 'ls-tree', '--name-only', base]);
    expect(String(landed)).toContain('T1.js');
    expect(await git.currentBranch()).toBe('elsewhere');
    expect(existsSync(join(project.root, 'draft.txt'))).toBe(true);
  });

  it('won’t merge over uncommitted changes, and says so; the next landing picks it up', async () => {
    await git.init();
    await buildTask('T1');
    await write('theirs.js');
    await git.commitAll('Their own work');
    await write('draft.txt');

    expect((await closeTask(project.store, 'T1')).message).toContain(
      'You have uncommitted changes',
    );
    expect(existsSync(join(project.root, 'T1.js'))).toBe(false);

    await git.commitAll('Their draft');
    expect((await landApprovedWork(project.store, git)).landed).toEqual(['T1']);
  });

  it('holds work that conflicts with the user’s, and says how to land it', async () => {
    await git.init();
    await buildTask('T1', { 'shared.txt': 'from Dazza' });
    await write('shared.txt', 'from the user');
    await git.commitAll('Their version');

    const closed = await closeTask(project.store, 'T1');
    expect(closed.message).toContain('conflicts with changes on');
    expect(closed.message).toContain('git merge dazza/T1-setup');
    expect(await git.isClean()).toBe(true); // the failed merge was rolled back
  });

  it('builds on approved work that hasn’t landed, and lands the two in order', async () => {
    await git.init();
    await buildTask('T1');
    await write('theirs.js');
    await git.commitAll('Their own work'); // T1 now needs a merge…
    await write('draft.txt'); // …which uncommitted changes rule out
    expect((await closeTask(project.store, 'T1')).message).toContain('hasn’t landed yet');

    // T2 depends on T1, so it starts with T1's work merged in.
    const t2 = await buildTask('T2');
    expect(existsSync(join(t2.dir as string, 'T1.js'))).toBe(true);

    await git.commitAll('Their draft');
    expect((await closeTask(project.store, 'T2')).message).toContain('along with T1');
    expect(existsSync(join(project.root, 'T2.js'))).toBe(true);
  });

  it('starts a task with the packages already installed, when git ignores them', async () => {
    await git.init();
    await write('.gitignore', 'node_modules/\n');
    await write('package-lock.json', '{"lockfileVersion": 3}');
    await git.commitAll('Project');
    await mkdir(join(project.root, 'node_modules', 'left-pad'), { recursive: true });
    await write('node_modules/left-pad/index.js', 'pad');

    const build = await startTask(project.store, git, await task('T1'));
    expect(existsSync(join(build.dir as string, 'node_modules', 'left-pad', 'index.js'))).toBe(
      true,
    );
    const activity = await project.store.readActivity('T1');
    expect(activity.at(-1)?.text).toContain('Reused the installed packages');
  });

  it('notes at handoff whether Dazza can start the work for the user to try', async () => {
    await git.init();
    await buildTask('T1', { 'index.js': 'module.exports = 1' }); // a library: nothing to start
    expect((await task('T1')).handoff?.runnable).toBe(false);
    await buildTask('T3', { 'package.json': '{"scripts":{"dev":"node server.js"}}' }); // an app
    expect((await task('T3')).handoff?.runnable).toBe(true);
  });

  it('never copies packages git would commit', async () => {
    await git.init();
    await write('package-lock.json', '{"lockfileVersion": 3}'); // and no .gitignore
    await git.commitAll('Project');
    await mkdir(join(project.root, 'node_modules', 'left-pad'), { recursive: true });
    const build = await startTask(project.store, git, await task('T1'));
    expect(existsSync(join(build.dir as string, 'node_modules'))).toBe(false);
  });

  it('starts over what was built on a task that’s started over', async () => {
    await git.init();
    await buildTask('T1'); // in review
    await buildTask('T2'); // built ahead, on T1's work
    await buildTask('T3'); // doesn't depend on T1: its branch has none of T1's work
    const redone = await redoTask(project.store, git, 'T1');
    expect(redone.message).toContain('T2 was built on it, so it starts over too');
    const status = (id: string) =>
      project.store.readPlan().then((p) => p?.tasks.find((t) => t.id === id)?.status);
    expect(await status('T2')).toBe('planned');
    expect(await project.store.readTaskBuild('T2')).toBeUndefined();
  });

  it('won’t land work built on a task that was then cancelled', async () => {
    await git.init();
    await buildTask('T1'); // in review, not landed
    await buildTask('T2'); // built with T1's work merged in
    await cancelTask(project.store, 'T1');

    const closed = await closeTask(project.store, 'T2');
    expect(closed.message).toContain('which you cancelled');
    expect(existsSync(join(project.root, 'T2.js'))).toBe(false);
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
    const summary = workReport;
    expect(await submitTask(project.store, 'T1', summary)).toMatchObject({ ok: true });
    expect(await submitTask(project.store, 'T1', summary)).toMatchObject({ ok: false });
    const submitted = (await project.store.readEvents()).filter((e) => e.type === 'task_submitted');
    expect(submitted).toHaveLength(1);
  });
});
