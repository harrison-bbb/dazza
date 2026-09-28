import { beforeEach, describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/chat/session.js';
import { stripAnsi } from '../../src/chat/style.js';
import { setStatus } from '../../src/core/actions.js';
import { Manager } from '../../src/core/manager.js';
import { blockTask, submitTask } from '../../src/core/work.js';
import type { AgentEvent, AgentRunOptions } from '../../src/providers/types.js';
import { FakeProvider } from '../fakes.js';
import { makePlan, makeTask, workReport } from '../fixtures.js';
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
      await submitTask(project.store, 'T1', workReport);
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

  it('picks the build back up once a blocked task is answered, unless the user stopped it', async () => {
    let runs = 0;
    provider.onRun = async (options) => {
      if (!options.autonomous) return;
      if (runs++ === 0) await blockTask(project.store, 'T1', 'Which database?');
      else await submitTask(project.store, 'T1', workReport);
    };
    session.startBuild();
    await session.idle();
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('blocked');
    expect(await session.resumeIfReady()).toBeUndefined(); // nothing's ready yet

    await setStatus(project.store, 'T1', 'planned', 'Postgres');
    expect(await session.resumeIfReady()).toBe('T1');
    await session.idle();
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('review');

    // Once the user stops building, answering doesn't start it again.
    await session.stopBuild();
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T2' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    expect(await session.resumeIfReady()).toBeUndefined();
  });

  it('starts building when the user asks for it in the conversation', async () => {
    let started = 0;
    const chat = new ChatSession({
      store: project.store,
      config: project.config,
      provider: new FakeProvider([
        { type: 'started', sessionId: 's', model: 'fake' },
        { type: 'tool_use', id: 't1', tool: 'mcp__dazza__start_build', input: {} },
        { type: 'text', text: 'Starting now.' },
        { type: 'finished', ok: true, output: '', sessionId: 's', durationMs: 1 },
      ]),
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider: new FakeProvider([
          { type: 'started', sessionId: 's', model: 'fake' },
          { type: 'tool_use', id: 't1', tool: 'mcp__dazza__start_build', input: {} },
          { type: 'text', text: 'Starting now.' },
          { type: 'finished', ok: true, output: '', sessionId: 's', durationMs: 1 },
        ]),
        projectRoot: project.root,
        mcpServer: { command: 'node', args: [] },
      }),
      workerMcp: { command: 'node', args: [] },
      boardUrl: 'http://localhost:4777',
      output: { say: () => {}, print: () => {}, status: () => {} },
      onStartBuild: () => {
        started++;
      },
    });
    chat.send('go ahead and build it');
    await chat.idle();
    expect(started).toBe(1);
  });

  it('keeps a plan sent back for more detail out of the conversation', async () => {
    const said: string[] = [];
    const events: AgentEvent[] = [
      { type: 'started', sessionId: 's', model: 'fake' },
      { type: 'text', text: 'Writing it up now.' },
      { type: 'tool_use', id: 'a', tool: 'mcp__dazza__save_plan', input: {} },
      { type: 'tool_result', id: 'a', ok: false },
      { type: 'text', text: 'Fixing the flagged descriptions now.' },
      { type: 'tool_use', id: 'b', tool: 'mcp__dazza__save_plan', input: {} },
      { type: 'tool_result', id: 'b', ok: true },
      { type: 'text', text: 'Plan’s saved.' },
      { type: 'finished', ok: true, output: '', sessionId: 's', durationMs: 1 },
    ];
    const chat = new ChatSession({
      store: project.store,
      config: project.config,
      provider: new FakeProvider(events),
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider: new FakeProvider(events),
        projectRoot: project.root,
        mcpServer: { command: 'node', args: [] },
      }),
      workerMcp: { command: 'node', args: [] },
      boardUrl: 'http://localhost:4777',
      output: { say: (text) => said.push(stripAnsi(text)), print: () => {}, status: () => {} },
    });
    chat.send('yes, write it up');
    await chat.idle();
    expect(said).toContain('Writing it up now.');
    expect(said).toContain('Plan’s saved.');
    expect(said.join('\n')).not.toContain('Fixing');
  });

  it('shows what Dazza reads and looks up as it goes, like Claude Code', async () => {
    const printed: string[] = [];
    const events: AgentEvent[] = [
      { type: 'started', sessionId: 's', model: 'fake' },
      { type: 'tool_use', id: 'a', tool: 'Read', input: { file_path: `${project.root}/a.ts` } },
      { type: 'tool_use', id: 'b', tool: 'Read', input: { file_path: `${project.root}/b.ts` } },
      { type: 'tool_use', id: 'c', tool: 'WebSearch', input: { query: 'neon free tier' } },
      { type: 'text', text: 'Neon’s free tier covers this.' },
      { type: 'finished', ok: true, output: '', sessionId: 's', durationMs: 1 },
    ];
    const chat = new ChatSession({
      store: project.store,
      config: project.config,
      provider: new FakeProvider(events),
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider: new FakeProvider(events),
        projectRoot: project.root,
        mcpServer: { command: 'node', args: [] },
      }),
      workerMcp: { command: 'node', args: [] },
      boardUrl: 'http://localhost:4777',
      output: { say: () => {}, print: (text) => printed.push(stripAnsi(text)), status: () => {} },
    });
    chat.send('is neon free?');
    await chat.idle();
    expect(printed.join('\n')).toBe('  • Read 2 files\n  • Look up neon free tier');
  });

  it('compacts the conversation with the agent’s own /compact, and says how much room it made', async () => {
    const provider = new FakeProvider();
    const chat = new ChatSession({
      store: project.store,
      config: project.config,
      provider,
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider,
        projectRoot: project.root,
        mcpServer: { command: 'node', args: [] },
      }),
      workerMcp: { command: 'node', args: [] },
      boardUrl: 'http://localhost:4777',
      output: { say: () => {}, print: () => {}, status: () => {} },
    });
    expect(await chat.compact()).toMatch(/^Nothing to compact yet/);
    await project.store.writeManagerSession('session-1', 'claude');
    expect(await chat.compact()).toBe(
      'Compacted our conversation (50k → 2k tokens). The plan and the board are as they were.',
    );
    expect(provider.compactions).toEqual(['session-1']);
  });

  it('streams a reply line by line, showing the unfinished line live, and prints it once', async () => {
    const printed: string[] = [];
    const said: string[] = [];
    const drafts: (string | undefined)[] = [];
    const events: AgentEvent[] = [
      { type: 'started', sessionId: 's', model: 'fake' },
      { type: 'text_delta', text: 'Hello\nwor' },
      { type: 'text_delta', text: 'ld\nbye' },
      { type: 'text', text: 'Hello\nworld\nbye' },
      { type: 'finished', ok: true, output: '', sessionId: 's', durationMs: 1 },
    ];
    const chat = new ChatSession({
      store: project.store,
      config: project.config,
      provider: new FakeProvider(events),
      manager: new Manager({
        store: project.store,
        config: project.config,
        provider: new FakeProvider(events),
        projectRoot: project.root,
        mcpServer: { command: 'node', args: [] },
      }),
      workerMcp: { command: 'node', args: [] },
      boardUrl: 'http://localhost:4777',
      output: {
        say: (text) => said.push(text),
        print: (text) => printed.push(stripAnsi(text)),
        status: () => {},
        draft: (text) => drafts.push(text && stripAnsi(text)),
      },
    });
    chat.send('hi');
    await chat.idle();
    expect(printed).toEqual(['\n● Hello', '  world', '  bye', '']);
    expect(drafts).toEqual(['  wor', '  bye', undefined]);
    expect(said).toEqual([]); // not printed a second time
  });
});
