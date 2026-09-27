import { describe, expect, it } from 'vitest';
import { describeState, Manager } from '../../src/core/manager.js';
import type { AgentEvent, AgentProvider, AgentRunOptions } from '../../src/providers/types.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

/** Records what it was asked to run and replays canned events. */
class FakeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Fake';
  readonly runs: AgentRunOptions[] = [];

  async detect() {
    return { installed: true as const, version: '1.0.0', loggedIn: true };
  }

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    this.runs.push(options);
    yield { type: 'started', sessionId: 'session-1', model: 'fake' };
    yield { type: 'text', text: 'What are we building?' };
    yield { type: 'finished', ok: true, output: '', sessionId: 'session-1', durationMs: 1 };
  }
}

describe('Manager', () => {
  const project = useTempProject();

  const setup = () => {
    const provider = new FakeProvider();
    const manager = new Manager({
      store: project.store,
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

  it('resumes the same session on the next message', async () => {
    const { provider, manager } = setup();
    await drain(manager.send('first'));
    await drain(manager.send('second'));
    expect(provider.runs[0]?.resumeSessionId).toBeUndefined();
    expect(provider.runs[1]?.resumeSessionId).toBe('session-1');
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

describe('describeState', () => {
  it('says when there is no plan', () => {
    expect(describeState(undefined)).toContain('No plan yet.');
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
});
