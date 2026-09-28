import { describe, expect, it } from 'vitest';
import { describeState, Manager } from '../../src/core/manager.js';
import type { AgentEvent } from '../../src/providers/types.js';
import { FakeProvider } from '../fakes.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('Manager', () => {
  const project = useTempProject();

  const setup = () => {
    const provider = new FakeProvider();
    const manager = new Manager({
      store: project.store,
      config: project.config,
      provider,
      projectRoot: project.root,
      mcpServer: { command: 'node', args: ['dazza', 'mcp'] },
    });
    return { provider, manager };
  };

  const drain = async (events: AsyncIterable<AgentEvent>) => {
    const all: AgentEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  };

  it('relays agent events', async () => {
    const { manager } = setup();
    const events = await drain(manager.send('hi'));
    expect(events.map((e) => e.type)).toEqual(['started', 'text', 'finished']);
  });

  it('says when the user is writing from their phone', async () => {
    const { provider, manager } = setup();
    await drain(manager.send('from the terminal'));
    await drain(manager.send('from slack', undefined, 'slack'));
    expect(provider.runs[0]?.prompt).not.toContain('on their phone');
    expect(provider.runs[1]?.prompt).toContain('The user is writing from Slack, on their phone');
  });

  it('resumes the same session on the next message', async () => {
    const { provider, manager } = setup();
    await drain(manager.send('first'));
    await drain(manager.send('second'));
    expect(provider.runs[0]?.resumeSessionId).toBeUndefined();
    expect(provider.runs[1]?.resumeSessionId).toBe('session-1');
  });

  it('starts a fresh conversation when the old one can’t be resumed', async () => {
    const { provider, manager } = setup();
    await project.store.writeManagerSession('deleted-session', 'claude');
    const gone: AgentEvent = {
      type: 'finished',
      ok: false,
      output: 'No conversation found with session ID: deleted-session',
      sessionId: 'deleted-session',
      durationMs: 0,
    };
    const fresh = [...provider.events];
    provider.events.splice(0, provider.events.length, gone);
    provider.onRun = async () => {
      // The retry, without the stale session, works as normal.
      if (provider.runs.length === 2) provider.events.splice(0, provider.events.length, ...fresh);
    };

    const events = await drain(manager.send('hi'));
    expect(provider.runs.map((r) => r.resumeSessionId)).toEqual(['deleted-session', undefined]);
    expect(events.find((e) => e.type === 'text')).toMatchObject({
      text: expect.stringContaining('started a fresh one'),
    });
    expect(await project.store.readManagerSession('claude')).toBe('session-1');
  });

  it('doesn’t keep the id of a run that failed', async () => {
    const { provider, manager } = setup();
    provider.events.splice(0, provider.events.length, {
      type: 'finished',
      ok: false,
      output: 'Credit balance is too low',
      sessionId: '',
      durationMs: 0,
      error: { kind: 'credits', message: 'Credit balance is too low' },
    });
    await drain(manager.send('hi'));
    expect(await project.store.readManagerSession('claude')).toBeUndefined();
  });

  it('gives the agent current project state and no tools that edit code', async () => {
    const { provider, manager } = setup();
    await project.store.writePlan(makePlan([makeTask({ id: 'T1', title: 'Scaffold' })]));
    await drain(manager.send('status?'));

    const run = provider.runs[0];
    expect(run?.systemPrompt).toContain('You are Dazza');
    expect(run?.prompt).toMatch(
      /^<project-state>\n[\s\S]*T1 \[planned\] Scaffold[\s\S]*<\/project-state>\n\nstatus\?$/,
    );
    expect(run?.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'mcp__dazza__save_plan', 'mcp__dazza__set_status']),
    );
    for (const tool of ['Edit', 'Write', 'Bash', 'NotebookEdit']) {
      expect(run?.allowedTools).not.toContain(tool);
    }
    expect(run?.mcpServers).toEqual({ dazza: { command: 'node', args: ['dazza', 'mcp'] } });
  });
});

describe('Manager bookkeeping', () => {
  const project = useTempProject();

  it('uses the chosen model and records usage and limits', async () => {
    const provider = new FakeProvider([
      { type: 'started', sessionId: 's', model: 'sonnet' },
      {
        type: 'limits',
        windows: [{ id: 'five_hour', utilization: 0.4, resetsAt: '2026-09-27T12:00:00.000Z' }],
      },
      {
        type: 'finished',
        ok: true,
        output: '',
        sessionId: 's',
        durationMs: 1,
        usage: { tokens: 1000, costUsd: 0.5 },
      },
    ]);
    await project.config.updateSettings({ model: 'sonnet' });
    const manager = new Manager({
      store: project.store,
      config: project.config,
      provider,
      projectRoot: project.root,
      mcpServer: { command: 'node', args: [] },
    });

    for await (const _ of manager.send('hi')) {
      // drain
    }
    for await (const _ of manager.send('again')) {
      // drain
    }

    expect(provider.runs[0]?.model).toBe('sonnet');
    expect(await project.store.readUsage()).toEqual({ runs: 2, tokens: 2000, costUsd: 1 });
    expect((await project.config.readLimits())?.windows[0]?.utilization).toBe(0.4);
  });
});

describe('describeState', () => {
  it('says when there is no plan', () => {
    expect(describeState(undefined)).toContain('No plan yet.');
    expect(describeState(undefined)).toContain('empty, a new project');
    expect(describeState(undefined, [], 'a Go project (3 files)')).toContain(
      'Working directory: a Go project (3 files).',
    );
  });

  it('includes recent board comments', () => {
    const state = describeState(makePlan([makeTask({ id: 'T1' })]), [
      {
        at: '2026-09-27T10:00:00Z',
        type: 'comment',
        actor: 'user',
        taskId: 'T1',
        message: 'Use Postgres',
      },
    ]);
    expect(state).toContain('T1 · user (2026-09-27T10:00:00Z): Use Postgres');
  });

  it('summarises an approved plan with progress', () => {
    const plan = {
      ...makePlan([makeTask({ id: 'T1', status: 'closed' }), makeTask({ id: 'T2' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    };
    expect(describeState(plan)).toContain('approved, 1/2 tasks closed');
  });

  it('tells Dazza what the builders are doing, so it can say how things are going', () => {
    const plan = makePlan([
      makeTask({
        id: 'T1',
        status: 'building',
        subtasks: [
          { id: 'T1.1', title: 'a', description: '', status: 'closed' },
          { id: 'T1.2', title: 'b', description: '', status: 'planned' },
        ],
      }),
    ]);
    const state = describeState(plan, [], undefined, {
      T1: [{ at: new Date().toISOString(), taskId: 'T1', kind: 'do', text: 'Ran npm test' }],
    });
    expect(state).toContain("What T1's builder is doing (1 of 2 subtasks done; latest step last):");
    expect(state).toContain('- just now: Ran npm test');
  });
});
