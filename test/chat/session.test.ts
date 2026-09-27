import { beforeEach, describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/chat/session.js';
import { Manager } from '../../src/core/manager.js';
import { submitTask } from '../../src/core/work.js';
import { Git } from '../../src/git/git.js';
import type { AgentRunOptions } from '../../src/providers/types.js';
import { FakeProvider } from '../fakes.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('ChatSession', () => {
  const project = useTempProject();
  let provider: FakeProvider;
  let said: string[];
  let session: ChatSession;

  beforeEach(async () => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    provider = new FakeProvider();
    said = [];
    const mcp = { command: 'node', args: [] };
    session = new ChatSession({
      store: project.store,
      config: project.config,
      provider,
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider,
        projectRoot: project.root,
        mcpServer: mcp,
      }),
      workerMcp: mcp,
      boardUrl: 'http://localhost:4777',
      output: { say: (t) => said.push(t), print: (t) => said.push(t), status: () => {} },
    });
  });

  const chatPrompts = () =>
    provider.runs.filter((r) => !r.autonomous).map((r) => r.prompt.split('\n\n').at(-1));

  it('answers queued messages one at a time, in order', async () => {
    session.send('first');
    session.send('second');
    await session.idle();
    expect(chatPrompts()).toEqual(['first', 'second']);
    expect(said.filter((t) => t === 'What are we building?')).toHaveLength(2);
  });

  it('keeps talking while a build runs', async () => {
    let releaseBuild: () => void = () => {};
    const buildHeld = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    provider.onRun = async (options: AgentRunOptions) => {
      if (!options.autonomous) return;
      await buildHeld; // the "worker" is busy until we let it finish
      await submitTask(project.store, 'T1', {
        summary: 'Done',
        howToVerify: ['x'],
      });
    };

    expect(session.startBuild()).toBe(true);
    expect(session.startBuild()).toBe(false); // only one build at a time
    session.send('how is it going?');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(chatPrompts()).toEqual(['how is it going?']); // answered mid-build
    expect(session.isBuilding).toBe(true);

    releaseBuild();
    await session.idle();
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('review');
    expect(said.some((t) => t.includes('T1 is ready for your review'))).toBe(true);
  });

  it('stops a build cleanly, pausing the task', async () => {
    provider.onRun = async (options) => {
      // Work until stopped (checking first, in case the stop came before we started).
      if (!options.autonomous || options.signal?.aborted) return;
      await new Promise((resolve) => options.signal?.addEventListener('abort', resolve));
    };
    session.startBuild();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.stopBuild();
    expect(session.isBuilding).toBe(false);
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('planned');
  });
});
