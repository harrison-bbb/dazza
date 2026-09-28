import { describe, expect, it } from 'vitest';
import {
  addComment,
  approvePlan,
  cancelTask,
  closeTask,
  prioritise,
  requestChanges,
  setStatus,
} from '../../src/core/actions.js';
import type { Task } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('actions', () => {
  const project = useTempProject();
  const seed = (...tasks: Task[]) => project.store.writePlan(makePlan(tasks));
  const status = async (id: string) =>
    (await project.store.readPlan())?.tasks.find((t) => t.id === id)?.status;
  const lastEvent = async () => (await project.store.readEvents()).at(-1);

  describe('approvePlan', () => {
    it('needs a plan', async () => {
      expect(await approvePlan(project.store)).toMatchObject({ ok: false });
    });

    it('approves once and logs it as the user', async () => {
      await seed(makeTask({ id: 'T1' }));
      expect(await approvePlan(project.store)).toMatchObject({ ok: true });
      expect(await approvePlan(project.store)).toMatchObject({ ok: false });
      expect(await lastEvent()).toMatchObject({ type: 'plan_approved', actor: 'user' });
    });
  });

  describe('addComment', () => {
    const withSubtask = makeTask({
      id: 'T1',
      subtasks: [{ id: 'T1.1', title: 'a', description: '', status: 'planned' }],
    });

    it('records comments on tasks and subtasks, by user or Dazza', async () => {
      await seed(withSubtask);
      await addComment(project.store, 'T1', '  Use Postgres  ');
      await addComment(project.store, 'T1.1', 'On it', { actor: 'dazza' });
      expect(await project.store.readEvents()).toMatchObject([
        { type: 'comment', actor: 'user', taskId: 'T1', message: 'Use Postgres' },
        { type: 'comment', actor: 'dazza', taskId: 'T1.1', message: 'On it' },
      ]);
    });

    it('rejects empty comments and unknown items', async () => {
      await seed(withSubtask);
      expect(await addComment(project.store, 'T1', '   ')).toMatchObject({ ok: false });
      expect(await addComment(project.store, 'T9', 'hi')).toMatchObject({ ok: false });
      expect(await project.store.readEvents()).toEqual([]);
    });
  });

  describe('closeTask', () => {
    it('closes reviewed work', async () => {
      await seed(makeTask({ id: 'T1', status: 'review' }));
      expect(await closeTask(project.store, 'T1')).toMatchObject({ ok: true });
      expect(await status('T1')).toBe('closed');
      expect(await lastEvent()).toMatchObject({ type: 'task_approved', taskId: 'T1' });
    });

    it('refuses work that is not in review', async () => {
      await seed(makeTask({ id: 'T1', status: 'building' }));
      expect(await closeTask(project.store, 'T1')).toMatchObject({ ok: false });
      expect(await status('T1')).toBe('building');
    });

    it('only applies to tasks, not subtasks', async () => {
      await seed(
        makeTask({
          id: 'T1',
          subtasks: [{ id: 'T1.1', title: 'a', description: '', status: 'review' }],
        }),
      );
      expect(await closeTask(project.store, 'T1.1')).toMatchObject({ ok: false });
    });
  });

  describe('requestChanges', () => {
    it('sends reviewed work back to planned with the note as a comment', async () => {
      await seed(makeTask({ id: 'T1', status: 'review' }));
      expect(await requestChanges(project.store, 'T1', 'Make the button bigger')).toMatchObject({
        ok: true,
      });
      expect(await status('T1')).toBe('planned');
      expect(await lastEvent()).toMatchObject({
        type: 'comment',
        actor: 'user',
        message: 'Make the button bigger',
      });
    });

    it('needs a note', async () => {
      await seed(makeTask({ id: 'T1', status: 'review' }));
      expect(await requestChanges(project.store, 'T1', ' ')).toMatchObject({ ok: false });
      expect(await status('T1')).toBe('review');
    });
  });

  describe('cancelTask', () => {
    it('cancels open work but not finished work', async () => {
      await seed(
        makeTask({ id: 'T1', status: 'blocked' }),
        makeTask({ id: 'T2', status: 'closed' }),
      );
      expect(await cancelTask(project.store, 'T1')).toMatchObject({ ok: true });
      expect(await status('T1')).toBe('cancelled');
      expect(await cancelTask(project.store, 'T2')).toMatchObject({ ok: false });
    });
  });

  describe('setStatus', () => {
    it('unblocks and defers work, recording the reason', async () => {
      await seed(makeTask({ id: 'T1', status: 'blocked' }), makeTask({ id: 'T2' }));
      expect(
        await setStatus(project.store, 'T1', 'planned', 'Tags are case-insensitive'),
      ).toMatchObject({
        ok: true,
      });
      expect(await setStatus(project.store, 'T2', 'backlog')).toMatchObject({ ok: true });
      expect([await status('T1'), await status('T2')]).toEqual(['planned', 'backlog']);
      expect(await lastEvent()).toMatchObject({ type: 'task_moved', taskId: 'T2' });
    });

    it('routes review work through the review rules', async () => {
      await seed(
        makeTask({ id: 'T1', status: 'review' }),
        makeTask({ id: 'T2', status: 'review' }),
      );
      expect(await setStatus(project.store, 'T1', 'planned')).toMatchObject({ ok: false });
      expect(await setStatus(project.store, 'T1', 'planned', 'Bigger button')).toMatchObject({
        ok: true,
      });
      expect(await setStatus(project.store, 'T2', 'closed')).toMatchObject({ ok: true });
      expect([await status('T1'), await status('T2')]).toEqual(['planned', 'closed']);
    });

    it('refuses moves that skip the workflow', async () => {
      await seed(makeTask({ id: 'T1', status: 'building' }));
      expect(await setStatus(project.store, 'T1', 'backlog')).toMatchObject({ ok: false });
      expect(await status('T1')).toBe('building');
    });
  });

  it('drops one subtask, leaving the rest of the task as it was', async () => {
    await project.store.writePlan(
      makePlan([
        makeTask({
          id: 'T3',
          subtasks: [
            { id: 'T3.1', title: 'Edit text', description: '', status: 'planned' },
            { id: 'T3.2', title: 'Due dates', description: '', status: 'planned' },
          ],
        }),
      ]),
    );
    expect(await cancelTask(project.store, 'T3.2')).toMatchObject({ ok: true });
    const task = (await project.store.readPlan())?.tasks[0];
    expect(task?.status).toBe('planned');
    expect(task?.subtasks.map((s) => s.status)).toEqual(['planned', 'cancelled']);
    expect(await cancelTask(project.store, 'T3.2')).toMatchObject({ ok: false });
  });

  it('moves a task to the front of the queue, and says what it still waits on', async () => {
    await project.store.writePlan(
      makePlan([
        makeTask({ id: 'T1', status: 'closed' }),
        makeTask({ id: 'T2' }),
        makeTask({ id: 'T3' }),
        makeTask({ id: 'T4', dependsOn: ['T3'] }),
      ]),
    );
    expect((await prioritise(project.store, 'T3')).message).toBe('T3 is first in line.');
    const order = async () => (await project.store.readPlan())?.tasks.map((t) => t.id);
    expect(await order()).toEqual(['T1', 'T3', 'T2', 'T4']);

    expect((await prioritise(project.store, 'T4', 'T2')).message).toBe(
      "T4 is ahead of T2, but it can't start until T3 (planned) is closed.",
    );
    expect(await order()).toEqual(['T1', 'T3', 'T4', 'T2']);
    expect((await prioritise(project.store, 'T1')).ok).toBe(false); // closed: nothing to reorder
  });
});
