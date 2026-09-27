import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/core/store.js';
import { makePlan, makeTask } from '../fixtures.js';

describe('Store', () => {
  let root: string;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dazza-'));
    store = new Store(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns undefined before anything is written', async () => {
    expect(await store.readPlan()).toBeUndefined();
    expect(await store.readScope()).toBeUndefined();
    expect(await store.readEvents()).toEqual([]);
  });

  it('round-trips a plan without leaving temp files behind', async () => {
    const plan = makePlan([makeTask({ id: 'T1' })]);
    await store.writePlan(plan);
    expect(await store.readPlan()).toEqual(plan);
    expect(await readdir(store.dir)).toEqual(['tasks.json']);
  });

  it('refuses to write an invalid plan', async () => {
    const invalid = makePlan([makeTask({ id: 'T1', dependsOn: ['T2'] })]);
    await expect(store.writePlan(invalid)).rejects.toThrow();
    expect(await store.readPlan()).toBeUndefined();
  });

  it('round-trips scope markdown', async () => {
    await store.writeScope('# Todo app\n');
    expect(await store.readScope()).toBe('# Todo app\n');
  });

  it('appends events in order', async () => {
    await store.appendEvent({ at: '2026-09-27T10:00:00Z', type: 'plan_created', message: 'a' });
    await store.appendEvent({
      at: '2026-09-27T10:01:00Z',
      type: 'task_started',
      taskId: 'T1',
      message: 'b',
    });
    const events = await store.readEvents();
    expect(events.map((e) => e.message)).toEqual(['a', 'b']);
  });
});
