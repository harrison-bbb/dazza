import { describe, expect, it } from 'vitest';
import { addSubtask, addTask, editSubtask, editTask } from '../../src/core/edits.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('edits', () => {
  const project = useTempProject();
  const seed = () =>
    project.store.writePlan({
      ...makePlan([
        makeTask({
          id: 'T1',
          status: 'closed',
          subtasks: [{ id: 'T1.1', title: 'a', description: '', status: 'closed' }],
        }),
        makeTask({ id: 'T2' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
  const plan = async () => {
    const current = await project.store.readPlan();
    if (!current) throw new Error('no plan');
    return current;
  };

  it('edits only the fields given, keeps approval, and logs it', async () => {
    await seed();
    expect(
      await editTask(project.store, 'T2', { title: 'Auth', description: undefined }),
    ).toMatchObject({
      ok: true,
    });
    const after = await plan();
    expect(after.tasks[1]).toMatchObject({ title: 'Auth', description: 'Do the thing.' });
    expect(after.approvedAt).not.toBeNull();
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      type: 'task_edited',
      actor: 'user',
      taskId: 'T2',
      message: 'Edited title',
    });
  });

  it('rejects edits that would break the plan', async () => {
    await seed();
    expect(await editTask(project.store, 'T2', { dependsOn: ['T9'] })).toMatchObject({ ok: false });
    expect(await editTask(project.store, 'T9', { title: 'x' })).toMatchObject({ ok: false });
    expect(await editTask(project.store, 'T2', {})).toMatchObject({ ok: false });
    expect((await plan()).tasks[1]?.dependsOn).toEqual([]);
  });

  it('edits subtasks', async () => {
    await seed();
    await editSubtask(project.store, 'T1.1', { description: 'Now described' });
    expect((await plan()).tasks[0]?.subtasks[0]).toMatchObject({
      title: 'a',
      description: 'Now described',
    });
  });

  it('adds tasks with the next ids, subtasks included', async () => {
    await seed();
    await addTask(project.store, {
      title: 'Dark mode',
      description: 'Add a dark theme.',
      acceptanceCriteria: ['Toggle works'],
      subtasks: [{ title: 'Tokens' }],
      status: 'backlog',
    });
    const added = (await plan()).tasks.at(-1);
    expect(added).toMatchObject({
      id: 'T3',
      status: 'backlog',
      subtasks: [{ id: 'T3.1', status: 'planned' }],
    });
  });

  it('adds subtasks with the next id', async () => {
    await seed();
    await addSubtask(project.store, 'T1', { title: 'Follow-up' });
    expect((await plan()).tasks[0]?.subtasks.map((s) => s.id)).toEqual(['T1.1', 'T1.2']);
  });
});
