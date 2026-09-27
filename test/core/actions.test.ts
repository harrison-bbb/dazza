import { describe, expect, it } from 'vitest';
import { addComment, approvePlan } from '../../src/core/actions.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('approvePlan', () => {
  const project = useTempProject();

  it('needs a plan', async () => {
    expect(await approvePlan(project.store)).toMatchObject({ ok: false });
  });

  it('approves once and logs it', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect(await approvePlan(project.store)).toMatchObject({ ok: true });
    expect(await approvePlan(project.store)).toMatchObject({
      ok: false,
      message: 'Already approved.',
    });
    expect((await project.store.readPlan())?.approvedAt).not.toBeNull();
    expect((await project.store.readEvents()).map((e) => e.type)).toEqual(['plan_approved']);
  });
});

describe('addComment', () => {
  const project = useTempProject();

  it('records a trimmed comment against a task', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect(await addComment(project.store, 'T1', '  Use Postgres instead  ')).toMatchObject({
      ok: true,
    });
    expect(await project.store.readEvents()).toMatchObject([
      { type: 'comment', taskId: 'T1', message: 'Use Postgres instead' },
    ]);
  });

  it('rejects empty comments and unknown tasks', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect(await addComment(project.store, 'T1', '   ')).toMatchObject({ ok: false });
    expect(await addComment(project.store, 'T9', 'hi')).toMatchObject({ ok: false });
    expect(await project.store.readEvents()).toEqual([]);
  });
});
