import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { Store } from '../src/core/store.js';

/** A fresh project directory and store per test, cleaned up afterwards. */
export function useTempProject(): { root: string; store: Store } {
  const project = { root: '', store: undefined as unknown as Store };
  beforeEach(async () => {
    project.root = await mkdtemp(join(tmpdir(), 'dazza-'));
    project.store = new Store(project.root);
  });
  afterEach(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  return project;
}
