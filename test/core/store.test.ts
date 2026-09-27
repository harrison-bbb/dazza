import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('Store', () => {
  const project = useTempProject();

  it('returns undefined before anything is written', async () => {
    expect(await project.store.readPlan()).toBeUndefined();
    expect(await project.store.readScope()).toBeUndefined();
    expect(await project.store.readEvents()).toEqual([]);
  });

  it('round-trips a plan without leaving temp files behind', async () => {
    const plan = makePlan([makeTask({ id: 'T1' })]);
    await project.store.writePlan(plan);
    expect(await project.store.readPlan()).toEqual(plan);
    expect((await readdir(project.store.dir)).sort()).toEqual(['.gitignore', 'tasks.json']);
  });

  it('refuses to write an invalid plan', async () => {
    const invalid = makePlan([makeTask({ id: 'T1', dependsOn: ['T2'] })]);
    await expect(project.store.writePlan(invalid)).rejects.toThrow();
    expect(await project.store.readPlan()).toBeUndefined();
  });

  it('round-trips scope markdown', async () => {
    await project.store.writeScope('# Todo app\n');
    expect(await project.store.readScope()).toBe('# Todo app\n');
  });

  it('round-trips the manager session and keeps it out of git', async () => {
    expect(await project.store.readManagerSession()).toBeUndefined();
    await project.store.writeManagerSession('session-1');
    expect(await project.store.readManagerSession()).toBe('session-1');
    expect(await readFile(join(project.store.dir, '.gitignore'), 'utf8')).toContain('session.json');
  });

  it('appends events in order', async () => {
    await project.store.appendEvent({
      at: '2026-09-27T10:00:00Z',
      type: 'plan_created',
      message: 'a',
    });
    await project.store.appendEvent({
      at: '2026-09-27T10:01:00Z',
      type: 'task_started',
      taskId: 'T1',
      message: 'b',
    });
    const events = await project.store.readEvents();
    expect(events.map((e) => e.message)).toEqual(['a', 'b']);
  });
});
