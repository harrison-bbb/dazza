import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('Store', () => {
  const project = useTempProject();

  it('returns undefined before anything is written', async () => {
    expect(await project.store.readPlan()).toBeUndefined();
    expect(await project.store.readScope()).toBeUndefined();
    expect(await project.store.readEvents()).toEqual([]);
  });

  it('round-trips a plan without leaving temp files behind', async () => {
    const plan = makePlan([makeTask({ id: 'T1' })]);
    await project.store.writePlan(plan);
    expect(await project.store.readPlan()).toEqual(plan);
    expect((await readdir(project.store.dir)).sort()).toEqual(['.gitignore', 'tasks.json']);
  });

  it('skips a damaged event line instead of failing every read', async () => {
    await project.store.appendEvent({
      at: '2026-09-27T10:00:00.000Z',
      type: 'comment',
      message: 'one',
    });
    await appendFile(join(project.store.dir, 'events.jsonl'), '{"at":"2026-09-27T10:0');
    expect((await project.store.readEvents()).map((e) => e.message)).toEqual(['one']);
  });

  it('explains a damaged plan instead of crashing on it', async () => {
    await project.store.init();
    await writeFile(join(project.store.dir, 'tasks.json'), '{"version":1,"tasks":[{"id":"oops"}]}');
    await expect(project.store.readPlan()).rejects.toThrow(
      /\.dazza\/tasks\.json is damaged at tasks\.0/,
    );
  });

  it('refuses to write an invalid plan', async () => {
    const invalid = makePlan([makeTask({ id: 'T1', dependsOn: ['T2'] })]);
    await expect(project.store.writePlan(invalid)).rejects.toThrow();
    expect(await project.store.readPlan()).toBeUndefined();
  });

  it('round-trips scope markdown', async () => {
    await project.store.writeScope('# Todo app\n');
    expect(await project.store.readScope()).toBe('# Todo app\n');
  });

  it('round-trips the manager session and keeps it out of git', async () => {
    expect(await project.store.readManagerSession()).toBeUndefined();
    await project.store.writeManagerSession('session-1', 'claude');
    expect(await project.store.readManagerSession('claude')).toBe('session-1');
    // A Claude conversation can't be resumed by Codex.
    expect(await project.store.readManagerSession('codex')).toBeUndefined();
    await project.store.clearManagerSession();
    expect(await project.store.readManagerSession('claude')).toBeUndefined();
    expect(await readFile(join(project.store.dir, '.gitignore'), 'utf8')).toContain('session.json');
  });

  it('appends events in order', async () => {
    await project.store.appendEvent({
      at: '2026-09-27T10:00:00Z',
      type: 'plan_created',
      message: 'a',
    });
    await project.store.appendEvent({
      at: '2026-09-27T10:01:00Z',
      type: 'task_started',
      taskId: 'T1',
      message: 'b',
    });
    const events = await project.store.readEvents();
    expect(events.map((e) => e.message)).toEqual(['a', 'b']);
  });
});

describe('conversations', () => {
  const project = useTempProject();

  it('starts a new one each time, and /continue goes back to the last, losing nothing', async () => {
    const { store } = project;
    await store.writeManagerSession('monday', 'claude');
    // A new launch: a new conversation, with Monday's kept to go back to.
    await store.newConversation();
    expect(await store.readManagerSession('claude')).toBeUndefined();
    expect(await store.hasPreviousConversation('claude')).toBe(true);
    // Opening Dazza and closing it again without a word keeps Monday's.
    await store.newConversation();
    expect(await store.hasPreviousConversation('claude')).toBe(true);
    // Chat a little, then change your mind: the two swap, nothing is lost.
    await store.writeManagerSession('tuesday', 'claude');
    expect(await store.continueConversation('claude')).toBe(true);
    expect(await store.readManagerSession('claude')).toBe('monday');
    expect(await store.continueConversation('claude')).toBe(true);
    expect(await store.readManagerSession('claude')).toBe('tuesday');
  });

  it('won’t go back to another agent’s conversation', async () => {
    const { store } = project;
    await store.writeManagerSession('codex-thread', 'codex');
    await store.newConversation();
    expect(await store.continueConversation('claude')).toBe(false);
    expect(await store.continueConversation('codex')).toBe(true);
  });
});

describe('prompt history', () => {
  const project = useTempProject();

  it('keeps what was typed across sessions, the latest 500', async () => {
    const { store } = project;
    expect(await store.readHistory()).toEqual([]);
    await store.appendHistory('first');
    await store.appendHistory('two\nlines');
    expect(await store.readHistory()).toEqual(['first', 'two\nlines']);
    for (let i = 0; i < 520; i++) await store.appendHistory(`m${i}`);
    const history = await store.readHistory();
    expect(history).toHaveLength(500);
    expect(history.at(-1)).toBe('m519');
  });
});
