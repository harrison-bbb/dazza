import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { addComment } from '../../src/core/actions.js';
import { createMcpServer, type McpRole, savePlan } from '../../src/mcp/server.js';
import { makePlan, makeTask } from '../fixtures.js';
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

describe('MCP tools, called through a real client', () => {
  const project = useTempProject();

  const connect = async (role: McpRole = 'manager') => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(project.store, role).connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  };
  const text = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content);

  it('gives each role only its own tools', async () => {
    const names = async (role: McpRole) =>
      (await (await connect(role)).listTools()).tools.map((t) => t.name).sort();
    expect(await names('manager')).toEqual([
      'add_subtask',
      'add_task',
      'comment',
      'save_plan',
      'set_status',
      'update_item',
    ]);
    expect(await names('worker')).toEqual([
      'block',
      'check_messages',
      'comment',
      'submit',
      'update_subtask',
    ]);
  });

  it('lets the manager relay an instruction as the user', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    await (await connect()).callTool({
      name: 'comment',
      arguments: { id: 'T1', body: 'Use tabs', as: 'user' },
    });
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      actor: 'user',
      message: 'Use tabs',
    });
  });

  it("hands the worker the user's new comments on its next tool call, once", async () => {
    await project.store.writePlan({
      ...makePlan([
        makeTask({
          id: 'T1',
          status: 'building',
          subtasks: [{ id: 'T1.1', title: 'a', description: '', status: 'planned' }],
        }),
        makeTask({ id: 'T2' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    await project.store.writeTaskBuild('T1', {
      branch: 'b',
      baseBranch: 'main',
      startCommit: 'x',
      seenEvents: 0,
    });
    await addComment(project.store, 'T1.1', 'Make it blue');
    await addComment(project.store, 'T2', 'Not for this task');
    await addComment(project.store, 'T1', 'Dazza talking to itself', 'dazza');

    const worker = await connect('worker');
    const first = text(
      await worker.callTool({
        name: 'update_subtask',
        arguments: { id: 'T1.1', status: 'closed' },
      }),
    );
    expect(first).toContain('On T1.1: Make it blue');
    expect(first).not.toContain('Not for this task');
    expect(first).not.toContain('talking to itself');

    const second = text(
      await worker.callTool({ name: 'check_messages', arguments: { taskId: 'T1' } }),
    );
    expect(second).not.toContain('Make it blue');
  });

  it('edits, adds, moves and comments on work', async () => {
    await project.store.writePlan(
      makePlan([makeTask({ id: 'T1', status: 'review' }), makeTask({ id: 'T2' })]),
    );
    const client = await connect();

    await client.callTool({ name: 'update_item', arguments: { id: 'T2', title: 'Renamed' } });
    await client.callTool({
      name: 'add_subtask',
      arguments: { taskId: 'T2', title: 'Extra step' },
    });
    await client.callTool({ name: 'set_status', arguments: { id: 'T1', status: 'closed' } });
    await client.callTool({ name: 'comment', arguments: { id: 'T2', body: 'Noted.' } });

    const plan = await project.store.readPlan();
    expect(plan?.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ['T1', 'Task T1', 'closed'],
      ['T2', 'Renamed', 'planned'],
    ]);
    expect(plan?.tasks[1]?.subtasks.map((s) => s.title)).toEqual(['Extra step']);
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      actor: 'dazza',
      message: 'Noted.',
    });
  });

  it('reports rule violations as tool errors', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    const result = await (await connect()).callTool({
      name: 'set_status',
      arguments: { id: 'T1', status: 'closed' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("isn't in review");
  });

  it('records the revision summary in the scope history', async () => {
    const client = await connect();
    await client.callTool({
      name: 'save_plan',
      arguments: { scope: '# x', tasks: [makeTask({ id: 'T1' })], summary: 'First cut' },
    });
    expect((await project.store.readEvents()).at(-1)?.message).toBe('First cut');
  });
});
