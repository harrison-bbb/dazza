import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand } from '../util/process.js';

/**
 * Installed dependencies, reused from task to task. Every task is built in a
 * fresh worktree, which starts without `node_modules`, and installing from
 * scratch each time (Electron, Next, Prisma…) was most of a small task's
 * build time. So a new worktree gets a copy of a `node_modules` installed from
 * the same lockfile: from the user's checkout, another task's worktree, or the
 * cache that a finished worktree's packages are moved into. The copy is a
 * copy-on-write clone where the file system allows (macOS, btrfs), so it's
 * instant and takes no extra space.
 */

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
/** Finished worktrees' packages kept per project, newest first. */
const KEEP = 3;
/** Caches that can hold absolute paths to where they were made. */
const PATH_BOUND = ['.cache', '.vite'];

/** Which install a `node_modules` belongs with: a hash of the lockfile. Undefined without one. */
export async function lockKey(dir: string): Promise<string | undefined> {
  for (const name of LOCKFILES) {
    const body = await readFile(join(dir, name)).catch(() => undefined);
    if (body) return createHash('sha256').update(name).update(body).digest('hex').slice(0, 16);
  }
  return undefined;
}

/**
 * Give `worktree` the dependencies it would install, if a matching set exists:
 * the first of `sources` (checkouts) with the same lockfile, else the cache.
 * Resolves where they came from, or undefined when it still needs an install.
 */
export async function seedDependencies(
  worktree: string,
  sources: readonly string[],
  cacheDir: string,
): Promise<string | undefined> {
  const target = join(worktree, 'node_modules');
  if (existsSync(target)) return undefined;
  const key = await lockKey(worktree);
  if (!key) return undefined;
  for (const source of sources) {
    if (source === worktree || !existsSync(join(source, 'node_modules'))) continue;
    if ((await lockKey(source)) !== key) continue;
    if (await copyTree(join(source, 'node_modules'), target)) return source;
  }
  const cached = join(cacheDir, key, 'node_modules');
  if (existsSync(cached) && (await copyTree(cached, target))) return 'the cache';
  return undefined;
}

/** Before a worktree is removed: move its dependencies into the cache instead of deleting them. */
export async function keepDependencies(worktree: string, cacheDir: string): Promise<void> {
  const from = join(worktree, 'node_modules');
  const key = existsSync(from) ? await lockKey(worktree) : undefined;
  if (!key) return;
  const slot = join(cacheDir, key);
  try {
    await rm(slot, { recursive: true, force: true });
    await mkdir(slot, { recursive: true });
    // A rename: the cache is on the same disk as the worktrees.
    await rename(from, join(slot, 'node_modules'));
  } catch {
    await rm(slot, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await prune(cacheDir);
}

/** Only the newest few sets are worth their disk space. */
async function prune(cacheDir: string): Promise<void> {
  const slots = await readdir(cacheDir).catch(() => []);
  const dated = await Promise.all(
    slots.map(async (name) => ({
      name,
      at: (await stat(join(cacheDir, name)).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  );
  for (const old of dated.sort((a, b) => b.at - a.at).slice(KEEP)) {
    await rm(join(cacheDir, old.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Copy a directory tree as fast as this machine allows. False if it couldn't. */
async function copyTree(from: string, to: string): Promise<boolean> {
  const done = async () => {
    for (const name of PATH_BOUND) await rm(join(to, name), { recursive: true, force: true });
    return true;
  };
  const tool =
    process.platform === 'darwin'
      ? // clonefile(2): instant on APFS.
        await execCommand('cp', ['-cR', from, to])
      : process.platform === 'linux'
        ? await execCommand('cp', ['-a', '--reflink=auto', from, to])
        : // Many threads: Windows is slow with lots of small files one at a time.
          await execCommand('robocopy', [
            from,
            to,
            '/E',
            '/SL',
            '/MT:16',
            '/NFL',
            '/NDL',
            '/NJH',
            '/NJS',
            '/R:0',
            '/W:0',
          ]);
  // robocopy's exit codes below 8 mean success.
  const ok =
    tool !== undefined && (process.platform === 'win32' ? tool.exitCode < 8 : tool.exitCode === 0);
  if (ok && existsSync(to)) return done();
  await rm(to, { recursive: true, force: true }).catch(() => undefined);
  try {
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    return done();
  } catch {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
}
