import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CommandContext, parseCommand } from '../../src/chat/commands.js';
import { stripAnsi } from '../../src/chat/style.js';
import { addComment } from '../../src/core/actions.js';
import type { Plan } from '../../src/core/schema.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('work commands', () => {
  const project = useTempProject();

  function context(answer = true) {
    const said: string[] = [];
    const ctx = {
      store: project.store,
      boardUrl: 'http://localhost:4777',
      say: (text: string) => said.push(stripAnsi(text)),
      confirm: async () => answer,
      stopBuild: async () => {},
      status: () => {},
      building: () => false,
      chatting: () => false,
      context: () => ({ tokens: 150_000, window: 200_000 }),
      resetContext: () => {},
      compact: async () => '',
    } as unknown as CommandContext;
    return { ctx, said };
  }
  const run = async (ctx: CommandContext, line: string) => {
    const { command, args } = parseCommand(line);
    if (!command) throw new Error(`No command for ${line}`);
    await command.run(ctx, args);
  };
  const plan = (): Plan => ({
    ...makePlan([
      makeTask({ id: 'T1', title: 'Setup', status: 'closed', size: 'S' }),
      makeTask({
        id: 'T2',
        title: 'Editor',
        status: 'review',
        size: 'M',
        handoff: {
          summary: 'Built the editor.',
          howToVerify: ['npm run dev', 'Open /'],
          criteria: [{ criterion: 'Saves', met: false, evidence: 'Autosave not wired yet' }],
          checks: [{ name: 'Tests', passed: true }],
          screenshots: [],
          submittedAt: '2026-09-28T10:00:00Z',
        },
      }),
      makeTask({ id: 'T3', title: 'Payments', status: 'blocked', dependsOn: ['T2'] }),
      makeTask({ id: 'T4', title: 'Search' }),
    ]),
    approvedAt: '2026-09-27T10:00:00Z',
    milestones: [{ id: 'M1', title: 'Write', goal: 'Write notes', tasks: ['T1', 'T2'] }],
  });

  it('/tasks lists tasks by milestone, with status and size', async () => {
    await project.store.writePlan(plan());
    const { ctx, said } = context();
    await run(ctx, '/tasks');
    expect(said[0]).toContain('M1 Write · 1/2');
    expect(said[0]).toContain('◉ T2   Editor · M  in review');
    expect(said[0]).toContain('Other');
    expect(said[0]).toContain('⊘ T3   Payments  blocked');
  });

  it('/review shows what’s waiting, with what to do about each', async () => {
    await project.store.writePlan(plan());
    await addComment(project.store, 'T3', 'Which Stripe account?', { actor: 'dazza' });
    const { ctx, said } = context();
    await run(ctx, '/review');
    expect(said[0]).toContain('T2 Editor is ready for review');
    expect(said[0]).toContain('1 of 1 criteria not met');
    expect(said[0]).toContain('Check it: npm run dev → Open /');
    expect(said[0]).toContain('/accept T2 · /changes T2 <what to change>');
    expect(said[0]).toContain('T3 Payments needs you');
    expect(said[0]).toContain('Which Stripe account?');
  });

  it('/changes sends work back with a note; /next reorders; ids are case-insensitive', async () => {
    await project.store.writePlan(plan());
    const { ctx, said } = context();
    await run(ctx, '/changes t2 wire up autosave');
    expect(said.at(-1)).toContain('Requested changes');
    await run(ctx, '/next T4');
    expect(said.at(-1)).toContain('T4 is first in line');
    await run(ctx, '/accept');
    expect(said.at(-1)).toContain('Which task?');
  });

  it('/cancel asks first, and says who depends on the task', async () => {
    await project.store.writePlan(plan());
    const no = context(false);
    await run(no.ctx, '/cancel T2');
    expect(no.said.at(-1)).toBe('Kept it.');
    expect((await project.store.readPlan())?.tasks[1]?.status).toBe('review');

    const yes = context(true);
    await run(yes.ctx, '/cancel T2');
    expect((await project.store.readPlan())?.tasks[1]?.status).toBe('cancelled');
    expect(yes.said.at(-1)).toContain('record it in the change log');
  });

  it('/allow answers a permission request', async () => {
    await project.store.writePlan(plan());
    await project.store.updatePermissions('T3', (p) => ({
      ...p,
      pending: { command: 'brew install redis', why: 'Tests need it' },
    }));
    const { ctx, said } = context();
    await run(ctx, '/review');
    expect(said[0]).toContain('brew install redis');
    expect(said[0]).toContain('/allow T3 · /deny T3');
    await run(ctx, '/allow T3');
    expect(said.at(-1)).toContain('Allowed `brew install redis` for T3');
  });

  it('/try runs a task’s work and gives its address; /try stop stops it', async () => {
    await project.store.writePlan(plan());
    const dir = join(project.root, 'worktree');
    await mkdir(dir);
    await writeFile(join(dir, 'index.html'), '<h1>Editor</h1>');
    await project.store.writeTaskBuild('T2', {
      branch: 'dazza/T2-editor',
      dir,
      baseBranch: 'main',
      startCommit: 'abc',
      seenEvents: 0,
    });
    process.env.DAZZA_NO_BROWSER = '1';
    const { ctx, said } = context();
    await run(ctx, '/try T4');
    expect(said.at(-1)).toBe('T4 hasn’t been built yet.');
    await run(ctx, '/try T2');
    const url = /http:\/\/localhost:\d+/.exec(said.at(-1) ?? '')?.[0];
    expect(url).toBeDefined();
    expect(await (await fetch(url as string)).text()).toContain('Editor');
    await run(ctx, '/try stop');
    expect(said.at(-1)).toBe('Stopped T2’s app.');
  });
});
