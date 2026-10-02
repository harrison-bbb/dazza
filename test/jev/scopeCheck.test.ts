import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReportForCheck,
  scopeChecker,
  scopeQuestions,
  scopeState,
} from '../../src/jev/scopeCheck.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

const task = makeTask({
  id: 'T1',
  title: 'Sign-up form',
  acceptanceCriteria: ['Shows an error for a bad email', 'Saves the user', 'Has a dark mode'],
});

const report: ReportForCheck = {
  summary: 'You can sign up.',
  details: 'Added a form.',
  criteria: [
    {
      criterion: 'Shows an error for a bad email',
      met: true,
      evidence: 'Test "rejects bad email" passes',
    },
    { criterion: 'Saves the user', met: true, evidence: 'Done' },
    { criterion: 'Has a dark mode', met: false, evidence: 'Not started' },
  ],
  checks: [{ name: 'Tests (12 passed)', passed: true }],
};

/** Jev answering each criterion with the chance its evidence shows it's met. */
function jevSays(shown: Record<string, number> | 'down') {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    if (shown === 'down') return new Response('{}', { status: 500 });
    return Response.json({
      model: 'jev',
      answers: Object.fromEntries(
        Object.entries(shown).map(([id, noul]) => [id, { type: 'noul', noul }]),
      ),
    });
  });
  return sent;
}

describe('what the scope check asks', () => {
  it('asks only about criteria the builder says are met', () => {
    expect(Object.keys(scopeQuestions(report))).toEqual(['criterion_1', 'criterion_2']);
    expect(scopeQuestions(report).criterion_2?.instructions).toContain('"Saves the user"');
  });

  it('sends the task and the report, with changed files by name, never the code', () => {
    const files = Array.from({ length: 65 }, (_, i) => `src/f${i}.ts`);
    const state = scopeState(task, report, files);
    expect(state.task).toEqual({ title: 'Sign-up form', description: task.description });
    expect(state.report.criteria[1]).toEqual({
      criterion: 'Saves the user',
      builderSaysMet: true,
      evidence: 'Done',
    });
    expect(state.report.changedFiles).toHaveLength(61);
    expect(state.report.changedFiles.at(-1)).toBe('…and 5 more');
  });
});

describe('scopeChecker', () => {
  const project = useTempProject();
  const check = () => scopeChecker(project.store, project.config)(task, report, ['src/form.ts']);
  const sentBack = async () =>
    (await project.store.readEvents()).filter((e) => e.type === 'sent_back');

  beforeEach(async () => {
    await project.store.writePlan(makePlan([task]));
    await project.config.writeJev({ provider: 'typesafe', apiKey: 'k' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands over work whose evidence holds up', async () => {
    const sent = jevSays({ criterion_1: 0.95, criterion_2: 0.9 });
    expect(await check()).toEqual({ doubts: [] });
    expect(sent).toHaveLength(1);
    expect(await sentBack()).toEqual([]);
  });

  it('sends weak work back, naming each criterion and the evidence given', async () => {
    jevSays({ criterion_1: 0.95, criterion_2: 0.1 });
    const verdict = await check();
    expect(verdict.sendBack).toContain('- Saves the user (your evidence: Done)');
    expect(verdict.sendBack).not.toContain('bad email');
    expect((await sentBack()).map((e) => [e.taskId, e.message])).toEqual([
      ['T1', 'Sent back to the builder: the evidence didn’t show “Saves the user” was met.'],
    ]);
  });

  it('sends it back twice at most, then hands it over marked as unproven', async () => {
    jevSays({ criterion_1: 0.5, criterion_2: 0.1 });
    expect((await check()).sendBack).toBeDefined();
    expect((await check()).sendBack).toBeDefined();
    expect(await check()).toEqual({
      doubts: ['Shows an error for a bad email', 'Saves the user'],
    });
    expect(await sentBack()).toHaveLength(2);
  });

  it('starts counting again after the user asks for changes', async () => {
    jevSays({ criterion_1: 0.9, criterion_2: 0.1 });
    await check();
    await check();
    await project.store.appendEvent({
      at: new Date().toISOString(),
      type: 'task_rejected',
      taskId: 'T1',
      message: 'Requested changes',
    });
    expect((await check()).sendBack).toBeDefined();
  });

  it('hands over as usual when Jev is down, off, or not connected', async () => {
    const sent = jevSays('down');
    expect(await check()).toEqual({ doubts: [] });

    await project.config.updateSettings({ jev: { scopeCheck: false } });
    expect(await check()).toEqual({ doubts: [] });
    await project.config.updateSettings({ jev: {} });
    await project.config.clearJev();
    expect(await check()).toEqual({ doubts: [] });
    expect(sent).toHaveLength(1);
  });

  it('doesn’t call Jev when the builder claims nothing is met', async () => {
    const sent = jevSays({});
    const none = { ...report, criteria: report.criteria.map((c) => ({ ...c, met: false })) };
    expect(await scopeChecker(project.store, project.config)(task, none, [])).toEqual({
      doubts: [],
    });
    expect(sent).toHaveLength(0);
  });
});
