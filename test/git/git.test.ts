import { realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Git, taskBranch } from '../../src/git/git.js';
import { useTempProject } from '../helpers.js';

describe('Git', () => {
  const project = useTempProject();
  let git: Git;
  const write = (file: string, text: string) => writeFile(join(project.root, file), text);

  beforeEach(async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    git = new Git(project.root);
  });

  it('initialises a repository around existing files', async () => {
    await write('a.txt', 'a');
    expect(await git.isRepo()).toBe(false);
    await git.init();
    expect(await git.isRepo()).toBe(true);
    expect(await git.isClean()).toBe(true);
  });

  it('builds a branch in its own worktree and commits the work there', async () => {
    await git.init();
    const base = await git.currentBranch();
    const start = await git.head();
    const dir = join(project.root, '..', `${basename(project.root)}-wt`);

    await git.addWorktree(dir, 'dazza/T1-setup', base);
    const tree = new Git(dir);
    expect(await tree.currentBranch()).toBe('dazza/T1-setup');
    expect(await git.checkedOutAt('dazza/T1-setup')).toBe(await realpath(dir));
    expect(await git.checkedOutAt(base)).toBe(await realpath(project.root));

    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'util.js'), 'export {}');
    const commit = await tree.commitAll('T1: Setup');
    expect(commit).toBeDefined();
    expect(await tree.filesChanged(start, commit as string)).toBe(2);
    expect(await tree.commitAll('nothing')).toBeUndefined();
    expect(await git.head()).toBe(start); // the main checkout didn't move

    await git.removeWorktree(dir);
    expect(await git.checkedOutAt('dazza/T1-setup')).toBeUndefined();
    expect(await git.branchExists('dazza/T1-setup')).toBe(true);
  });

  it('merges, fast-forwarding when it can, and backs out of conflicts', async () => {
    await git.init();
    const base = await git.currentBranch();
    const dir = join(project.root, '..', `${basename(project.root)}-wt2`);
    await git.addWorktree(dir, 'dazza/T1', base);
    const tree = new Git(dir);
    await writeFile(join(dir, 'a.js'), 'task');
    const task = (await tree.commitAll('T1')) as string;

    expect(await git.merge(task, 'Merge T1', { ffOnly: true })).toEqual({ ok: true });
    expect(await git.head()).toBe(task);

    await writeFile(join(dir, 'a.js'), 'task again');
    const second = (await tree.commitAll('T1 again')) as string;
    await write('a.js', 'mine');
    await git.commitAll('mine');
    expect(await git.merge(second, 'Merge T1')).toMatchObject({ ok: false, conflict: true });
    expect(await git.isClean()).toBe(true);
    await git.removeWorktree(dir);
  });
});

describe('taskBranch', () => {
  it('makes a readable, safe branch name', () => {
    expect(taskBranch('T3', 'Markdown editor with autosave!')).toBe(
      'dazza/T3-markdown-editor-with-autosave',
    );
    expect(taskBranch('T9', '???')).toBe('dazza/T9');
  });
});
