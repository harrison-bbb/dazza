import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { execCommand } from '../util/process.js';

/**
 * The few git operations Dazza needs. Each task is built on its own branch, in
 * its own worktree (a separate checkout), so the user's checkout is never
 * switched or touched. Dazza commits the work when it's submitted.
 */
export class Git {
  constructor(readonly root: string) {}

  async isRepo(): Promise<boolean> {
    return (await this.run(['rev-parse', '--is-inside-work-tree'])).ok;
  }

  /** Make the project a repository, committing what's already there. */
  async init(): Promise<void> {
    await this.must(['init', '-q']);
    await this.excludeLocally('.dazza/');
    await this.must(['add', '-A']);
    await this.must(['commit', '-q', '--allow-empty', '-m', 'Initial commit (before Dazza)']);
  }

  /**
   * Keep a path out of git on this machine only (.git/info/exclude), without
   * touching the project's .gitignore.
   */
  async excludeLocally(pattern: string): Promise<void> {
    const file = join(await this.must(['rev-parse', '--git-dir']), 'info', 'exclude');
    const path = isAbsolute(file) ? file : join(this.root, file);
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current.split('\n').includes(pattern)) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  }

  /** Whether git tracks anything under a path. */
  async tracks(path: string): Promise<boolean> {
    return (await this.must(['ls-files', '--', path])) !== '';
  }

  async currentBranch(): Promise<string> {
    return this.must(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async head(): Promise<string> {
    return this.must(['rev-parse', 'HEAD']);
  }

  /** Whether there's at least one commit (a fresh `git init` has none). */
  async hasCommits(): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  }

  async commitEmpty(message: string): Promise<void> {
    await this.must(['commit', '-q', '--allow-empty', '-m', message]);
  }

  /** True when there are no uncommitted changes (untracked files count). */
  async isClean(): Promise<boolean> {
    return (await this.must(['status', '--porcelain'])) === '';
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  }

  /**
   * Check a branch out in its own directory, creating the branch from `from`
   * if it doesn't exist yet. Forgets worktrees whose directories were deleted
   * first, so a directory can be recreated.
   */
  async addWorktree(dir: string, branch: string, from: string): Promise<void> {
    await this.run(['worktree', 'prune']);
    await this.must(
      (await this.branchExists(branch))
        ? ['worktree', 'add', '-q', dir, branch]
        : ['worktree', 'add', '-q', '-b', branch, dir, from],
    );
  }

  /** A throwaway checkout of a commit, on no branch. */
  async addDetachedWorktree(dir: string, commit: string): Promise<void> {
    await this.must(['worktree', 'add', '-q', '--detach', dir, commit]);
  }

  /** Delete a worktree's directory, keeping its branch. Uncommitted changes in it are lost. */
  async removeWorktree(dir: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', dir]);
    await this.run(['worktree', 'prune']);
  }

  /** The directory a branch is checked out in, if it's checked out anywhere. */
  async checkedOutAt(branch: string): Promise<string | undefined> {
    const list = await this.must(['worktree', 'list', '--porcelain']);
    for (const entry of list.split('\n\n')) {
      const lines = entry.split('\n');
      const dir = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      if (dir && lines.includes(`branch refs/heads/${branch}`)) return dir;
    }
    return undefined;
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch]);
  }

  /** Point a branch at a commit. Only for branches that aren't checked out anywhere. */
  async setBranch(branch: string, commit: string): Promise<void> {
    await this.must(['branch', '-f', branch, commit]);
  }

  /**
   * Merge a commit into the checked-out branch: a fast-forward when possible,
   * otherwise a merge commit. On failure nothing changes, and the reason is
   * returned.
   */
  async merge(
    commit: string,
    message: string,
    { ffOnly = false } = {},
  ): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
    const result = await this.run([
      'merge',
      '-q',
      ...(ffOnly ? ['--ff-only'] : ['--no-edit', '-m', message]),
      commit,
    ]);
    if (result.ok) return { ok: true };
    const conflict = (await this.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok;
    if (conflict) await this.run(['merge', '--abort']);
    return { ok: false, conflict, error: result.err || result.out };
  }

  /** Commit everything. Returns the new commit, or undefined if there was nothing to commit. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.must(['add', '-A']);
    if ((await this.run(['diff', '--cached', '--quiet'])).ok) return undefined;
    await this.must(['commit', '-q', '-m', message]);
    return this.head();
  }

  /** How many files differ between two commits. */
  async filesChanged(from: string, to: string): Promise<number> {
    const names = await this.must(['diff', '--name-only', `${from}..${to}`]);
    return names ? names.split('\n').length : 0;
  }

  /** Whether `ancestor` is already part of `descendant`'s history. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', ancestor, descendant])).ok;
  }

  private async run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    const result = await execCommand('git', ['-C', this.root, ...args]);
    if (!result) throw new Error('git is not installed');
    return { ok: result.exitCode === 0, out: result.stdout.trim(), err: result.stderr.trim() };
  }

  private async must(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.err || result.out}`);
    return result.out;
  }
}

/** A readable branch name for a task, e.g. "dazza/T3-markdown-editor-with-autosave". */
export function taskBranch(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `dazza/${taskId}${slug ? `-${slug}` : ''}`;
}
