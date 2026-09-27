import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLock } from '../../src/util/lock.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('concurrent plan updates', () => {
  const project = useTempProject();

  it('never loses an update when writers race', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    // 20 writers each append a subtask at the same time; all must survive.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        project.store.updatePlan((plan) => {
          if (!plan) throw new Error('no plan');
          const [task] = plan.tasks;
          if (!task) throw new Error('no task');
          const subtask = {
            id: `T1.${i + 1}`,
            title: `S${i}`,
            description: '',
            status: 'planned' as const,
          };
          return [
            { ...plan, tasks: [{ ...task, subtasks: [...task.subtasks, subtask] }] },
            undefined,
          ];
        }),
      ),
    );
    expect((await project.store.readPlan())?.tasks[0]?.subtasks).toHaveLength(20);
  });

  it('cleans up its lock file', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    await project.store.updatePlan((plan) => [plan, undefined]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(project.root, '.dazza'))).some((f) => f.endsWith('.lock'))).toBe(
      false,
    );
  });

  it('takes over a stale lock, and never removes a lock it doesn’t hold', async () => {
    const path = join(project.root, 'x.lock');
    await writeFile(path, 'someone else');
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old); // left behind by a crashed process

    let during = '';
    await withLock(path, async () => {
      during = await readFile(path, 'utf8');
      await writeFile(path, 'taken over'); // as if ours went stale and another took it
    });
    expect(during).not.toBe('someone else');
    expect(await readFile(path, 'utf8')).toBe('taken over');
  });
});
