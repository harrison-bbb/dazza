import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  it('builds on a task branch and commits the work', async () => {
    await git.init();
    const base = await git.currentBranch();
    const start = await git.head();

    await git.checkout('dazza/T1-setup');
    await write('app.js', 'console.log(1)');
    await write('util.js', 'export {}');
    expect(await git.isClean()).toBe(false);

    const commit = await git.commitAll('T1: Setup');
    expect(commit).toBeDefined();
    expect(await git.filesChanged(start, commit as string)).toBe(2);
    expect(await git.commitAll('nothing')).toBeUndefined();

    // Approving fast-forwards the base branch to the task's commit.
    expect(await git.fastForward(base, commit as string)).toBe(true);
    await git.checkout(base);
    expect(await git.head()).toBe(commit);
  });

  it("won't fast-forward diverged history", async () => {
    await git.init();
    const base = await git.currentBranch();
    await git.checkout('dazza/T1');
    await write('a.js', '1');
    const task = (await git.commitAll('T1')) as string;
    await git.checkout(base);
    await write('b.js', '2');
    await git.commitAll('someone else');
    expect(await git.fastForward(base, task)).toBe(false);
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
