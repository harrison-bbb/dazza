import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepDependencies, lockKey, seedDependencies } from '../../src/core/deps.js';
import { useTempProject } from '../helpers.js';

describe('reusing installed dependencies', () => {
  const project = useTempProject();
  const dir = (name: string) => join(project.root, name);
  const cache = () => dir('cache');

  /** A checkout with a lockfile, and optionally something installed from it. */
  const checkout = async (name: string, lock: string, installed = false) => {
    await mkdir(dir(name), { recursive: true });
    await writeFile(join(dir(name), 'package-lock.json'), lock);
    if (installed) {
      await mkdir(join(dir(name), 'node_modules', 'electron'), { recursive: true });
      await writeFile(join(dir(name), 'node_modules', 'electron', 'index.js'), 'electron');
      await mkdir(join(dir(name), 'node_modules', '.vite'), { recursive: true });
    }
    return dir(name);
  };

  it('copies node_modules from a checkout installed from the same lockfile', async () => {
    const user = await checkout('user', 'lock v1', true);
    const task = await checkout('T2', 'lock v1');
    expect(await seedDependencies(task, [user], cache())).toBe(user);
    expect(await readFile(join(task, 'node_modules', 'electron', 'index.js'), 'utf8')).toBe(
      'electron',
    );
    // Caches that can hold the other checkout's paths are left behind.
    expect(existsSync(join(task, 'node_modules', '.vite'))).toBe(false);
    // The original is untouched.
    expect(existsSync(join(user, 'node_modules', 'electron', 'index.js'))).toBe(true);
  });

  it('leaves it to install when the lockfile differs, or there isn’t one', async () => {
    const user = await checkout('user', 'lock v1', true);
    expect(
      await seedDependencies(await checkout('T2', 'lock v2'), [user], cache()),
    ).toBeUndefined();
    await mkdir(dir('bare'));
    expect(await seedDependencies(dir('bare'), [user], cache())).toBeUndefined();
    expect(await lockKey(dir('bare'))).toBeUndefined();
  });

  it('keeps a finished task’s packages for the next task, and only the newest few', async () => {
    const done = await checkout('T1', 'lock v1', true);
    await keepDependencies(done, cache());
    expect(existsSync(join(done, 'node_modules'))).toBe(false); // moved, not copied
    const next = await checkout('T3', 'lock v1');
    expect(await seedDependencies(next, [], cache())).toBe('the cache');
    expect(existsSync(join(next, 'node_modules', 'electron', 'index.js'))).toBe(true);

    for (const v of ['v2', 'v3', 'v4', 'v5']) {
      await keepDependencies(await checkout(`old-${v}`, `lock ${v}`, true), cache());
    }
    expect(await readdir(cache())).toHaveLength(3);
  });

  it('never replaces packages a worktree already has', async () => {
    const user = await checkout('user', 'lock v1', true);
    const task = await checkout('T2', 'lock v1', true);
    expect(await seedDependencies(task, [user], cache())).toBeUndefined();
  });
});
