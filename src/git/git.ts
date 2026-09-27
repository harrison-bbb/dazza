import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { execCommand } from '../util/process.js';

/**
 * The few git operations Dazza needs, run in the project directory. Each task
 * is built on its own branch; Dazza commits the work when it's submitted.
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

  /** True when there are no uncommitted changes (untracked files count). */
  async isClean(): Promise<boolean> {
    return (await this.must(['status', '--porcelain'])) === '';
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  }

  /** Switch to a branch, creating it from the current commit if needed. */
  async checkout(branch: string): Promise<void> {
    await this.must(
      (await this.branchExists(branch))
        ? ['checkout', '-q', branch]
        : ['checkout', '-q', '-b', branch],
    );
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

  /**
   * Move `branch` forward to `commit` if that's a pure fast-forward. Returns false
   * when the histories have diverged, leaving everything as it was.
   */
  async fastForward(branch: string, commit: string): Promise<boolean> {
    if (!(await this.run(['merge-base', '--is-ancestor', branch, commit])).ok) return false;
    if ((await this.currentBranch()) === branch) {
      return (await this.run(['merge', '--ff-only', '-q', commit])).ok;
    }
    return (await this.run(['branch', '-f', branch, commit])).ok;
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
