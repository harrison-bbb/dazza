import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopTrying, tryingNow, tryTask } from '../../src/preview/trying.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('trying a task’s work', () => {
  const project = useTempProject();
  afterEach(async () => {
    await stopTrying();
  });

  const site = async () => {
    await project.store.writePlan(
      makePlan([
        makeTask({ id: 'T1', status: 'closed' }),
        makeTask({ id: 'T2', status: 'building' }),
      ]),
    );
    await writeFile(join(project.root, 'index.html'), '<h1>Hello</h1>');
  };

  it('starts one app at a time, even when asked twice at once', async () => {
    await site();
    const [first, second] = await Promise.all([
      tryTask(project.store, 'T1'),
      tryTask(project.store, 'T1'),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      message: expect.stringContaining('Already starting T1'),
    });
    expect(tryingNow()?.taskId).toBe('T1');
  });

  it('lets a stop that comes while it’s starting cancel the start', async () => {
    await site();
    const starting = tryTask(project.store, 'T1');
    expect(await stopTrying()).toBe('T1');
    expect(await starting).toMatchObject({
      ok: false,
      message: expect.stringContaining('Stopped before'),
    });
    expect(tryingNow()).toBeUndefined();
    // And the next try works.
    expect((await tryTask(project.store, 'T1')).ok).toBe(true);
  });

  it('won’t run work the builder is still in the middle of', async () => {
    await site();
    expect(await tryTask(project.store, 'T2')).toMatchObject({
      ok: false,
      message: expect.stringContaining('being built right now'),
    });
  });
});
