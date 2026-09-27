import { beforeEach, describe, expect, it } from 'vitest';
import { type BuildEvent, build, type Timing } from '../../src/core/builder.js';
import { submitTask } from '../../src/core/work.js';
import { Git } from '../../src/git/git.js';
import type {
  AgentError,
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
} from '../../src/providers/types.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

/** Each run plays the next scripted behaviour; the last one repeats. */
type Behaviour = 'submit' | 'crash' | 'hang' | { error: AgentError };

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Scripted';
  readonly runs: AgentRunOptions[] = [];
  constructor(
    private readonly script: Behaviour[],
    private readonly onSubmit: () => Promise<void>,
  ) {}

  async detect() {
    return { installed: true as const, version: '1', loggedIn: true };
  }

  async listModels() {
    return [];
  }

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    this.runs.push(options);
    const behaviour = this.script[Math.min(this.runs.length - 1, this.script.length - 1)];
    yield { type: 'started', sessionId: `session-${this.runs.length}`, model: 'x' };
    if (behaviour === 'crash') throw new Error('claude exited with code 1: segfault');
    if (behaviour === 'hang') {
      await new Promise((resolve) => options.signal?.addEventListener('abort', resolve));
      throw new Error('aborted');
    }
    if (behaviour === 'submit') await this.onSubmit();
    const error = typeof behaviour === 'object' ? behaviour.error : undefined;
    yield {
      type: 'finished',
      ok: !error,
      output: error?.message ?? 'done',
      sessionId: 's',
      durationMs: 1,
      ...(error && { error }),
    };
  }
}

// Quick waits for tests; the watchdog stays generous except where a hang is the point.
const fast: Partial<Timing> = {
  stallMs: 10_000,
  overloadDelayMs: 10,
  resumeMarginMs: 0,
  limitFallbackMs: 10,
};

describe('a resilient build', () => {
  const project = useTempProject();

  beforeEach(async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
  });

  const submit = () =>
    submitTask(project.store, new Git(project.root), 'T1', {
      summary: 'Done',
      howToVerify: ['x'],
    }).then(() => {});
  const run = async (script: Behaviour[], timing: Partial<Timing> = {}) => {
    const provider = new ScriptedProvider(script, submit);
    const events: BuildEvent[] = [];
    for await (const event of build({
      store: project.store,
      config: project.config,
      provider,
      mcpServer: { command: 'node', args: [] },
      timing: { ...fast, ...timing },
    })) {
      if (event.type !== 'agent') events.push(event);
    }
    return { provider, events, status: (await project.store.readPlan())?.tasks[0]?.status };
  };
  const lastComment = async () =>
    (await project.store.readEvents()).filter((e) => e.type === 'comment').at(-1)?.message;

  it('waits out a usage limit, then resumes the same session', async () => {
    const resetsAt = new Date(Date.now() + 50).toISOString();
    const { provider, events, status } = await run([
      { error: { kind: 'usage_limit', message: 'usage limit reached', resetsAt } },
      'submit',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'waiting', reason: 'usage_limit', until: resetsAt }),
    );
    expect(status).toBe('review');
    expect(provider.runs[1]?.resumeSessionId).toBe('session-1');
  });

  it('retries a crash once, resuming', async () => {
    const { events, status } = await run(['crash', 'submit']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'retrying' }));
    expect(status).toBe('review');
  });

  it('blocks a task that keeps crashing, with the error', async () => {
    const { status } = await run(['crash', 'crash']);
    expect(status).toBe('blocked');
    expect(await lastComment()).toContain('segfault');
  });

  it('stops a worker that goes silent, and says why', async () => {
    const { events, status } = await run(['hang'], { stallMs: 100 });
    expect(status).toBe('blocked');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'task_finished', outcome: 'blocked' }),
    );
    expect(await lastComment()).toContain('nothing happened');
  });

  it('backs off when the service is overloaded, then carries on', async () => {
    const { events, status } = await run([
      { error: { kind: 'overloaded', message: '529' } },
      'submit',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'waiting', reason: 'overloaded' }),
    );
    expect(status).toBe('review');
  });

  it('stops and asks for a top-up when credits run out', async () => {
    const { events, status } = await run([
      { error: { kind: 'credits', message: 'Credit balance is too low' } },
    ]);
    expect(status).toBe('planned'); // paused, picks up after the top-up
    expect(events.at(-1)).toMatchObject({
      type: 'stopped',
      reason: expect.stringContaining('console.anthropic.com/settings/billing'),
    });
  });
});
