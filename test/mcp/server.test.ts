import { describe, expect, it } from 'vitest';
import { savePlan } from '../../src/mcp/server.js';
import { makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('savePlan', () => {
  const project = useTempProject();

  it('writes scope, tasks and an event', async () => {
    const result = await savePlan(project.store, {
      scope: '# Todo app\n',
      tasks: [makeTask({ id: 'T1' }), makeTask({ id: 'T2', dependsOn: ['T1'] })],
    });

    expect(result.isError).toBeUndefined();
    expect(await project.store.readScope()).toBe('# Todo app\n');
    expect((await project.store.readPlan())?.tasks).toHaveLength(2);
    expect((await project.store.readEvents()).map((e) => e.type)).toEqual(['plan_created']);
  });

  it('returns validation problems to the agent instead of saving', async () => {
    const result = await savePlan(project.store, {
      scope: '# Broken\n',
      tasks: [makeTask({ id: 'T1', dependsOn: ['T7'] })],
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('T1 depends on unknown task T7');
    expect(await project.store.readPlan()).toBeUndefined();
  });

  it('sends a revised approved plan back for re-approval, keeping progress', async () => {
    await project.store.writePlan({
      version: 1,
      approvedAt: '2026-09-27T10:00:00Z',
      tasks: [makeTask({ id: 'T1', status: 'closed' }), makeTask({ id: 'T2' })],
    });
    const result = await savePlan(project.store, {
      scope: '# Bigger\n',
      tasks: [makeTask({ id: 'T1' }), makeTask({ id: 'T2' }), makeTask({ id: 'T3' })],
    });

    const plan = await project.store.readPlan();
    expect(result.isError).toBeUndefined();
    expect(plan?.approvedAt).toBeNull();
    expect(plan?.tasks.map((t) => t.status)).toEqual(['closed', 'planned', 'planned']);
    expect((await project.store.readEvents()).at(-1)?.type).toBe('scope_change_proposed');
  });

  it('refuses to drop work that has started', async () => {
    await project.store.writePlan({
      version: 1,
      approvedAt: '2026-09-27T10:00:00Z',
      tasks: [makeTask({ id: 'T1', status: 'building' })],
    });
    const result = await savePlan(project.store, { scope: 'x', tasks: [makeTask({ id: 'T9' })] });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('T1 (building)');
    expect((await project.store.readPlan())?.tasks[0]?.id).toBe('T1');
  });
});
