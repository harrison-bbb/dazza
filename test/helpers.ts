import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { Config } from '../src/core/config.js';
import { Store } from '../src/core/store.js';

/** A fresh project directory, store and user config per test, cleaned up afterwards. */
export function useTempProject(): { root: string; store: Store; config: Config } {
  const project = {
    root: '',
    store: undefined as unknown as Store,
    config: undefined as unknown as Config,
  };
  beforeEach(async () => {
    project.root = await mkdtemp(join(tmpdir(), 'dazza-'));
    project.store = new Store(project.root);
    project.config = new Config(join(project.root, '.config'));
  });
  afterEach(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  return project;
}
