import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../../src/board/api.js';
import { createBoardApp } from '../../src/board/server.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('board server', () => {
  const project = useTempProject();
  let webRoot: string;

  beforeEach(async () => {
    webRoot = join(project.root, 'web');
    await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
  });

  const app = () => createBoardApp(project.store, project.root, webRoot);
  const post = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = { 'x-dazza': '1' },
  ) =>
    app().request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  it('serves an empty project', async () => {
    const res = await app().request('http://localhost/api/project');
    const snapshot = (await res.json()) as ProjectSnapshot;
    expect(snapshot).toMatchObject({ scope: null, plan: null, events: [] });
  });

  it('serves the plan and scope', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    await project.store.writeScope('## Overview\n');
    const snapshot = (await (
      await app().request('http://localhost/api/project')
    ).json()) as ProjectSnapshot;
    expect(snapshot.scope).toBe('## Overview\n');
    expect(snapshot.plan?.tasks).toHaveLength(1);
  });

  it('approves the plan', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect((await post('/api/approve')).status).toBe(200);
    expect((await post('/api/approve')).status).toBe(409);
  });

  it('adds comments to tasks', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect((await post('/api/tasks/T1/comments', { body: 'Looks good' })).status).toBe(201);
    expect((await post('/api/tasks/T1/comments', { nope: 1 })).status).toBe(400);
    expect((await project.store.readEvents()).at(-1)?.message).toBe('Looks good');
  });

  it('closes, cancels and requests changes on tasks', async () => {
    await project.store.writePlan(
      makePlan([
        makeTask({ id: 'T1', status: 'review' }),
        makeTask({ id: 'T2', status: 'review' }),
        makeTask({ id: 'T3' }),
      ]),
    );
    expect((await post('/api/tasks/T1/close')).status).toBe(200);
    expect((await post('/api/tasks/T1/close')).status).toBe(409);
    expect((await post('/api/tasks/T2/request-changes', { body: 'Tweak it' })).status).toBe(200);
    expect((await post('/api/tasks/T3/cancel')).status).toBe(200);
    const statuses = (await project.store.readPlan())?.tasks.map((t) => t.status);
    expect(statuses).toEqual(['closed', 'planned', 'cancelled']);
  });

  it('serves handoff screenshots and nothing else', async () => {
    const dir = join(project.store.dir, 'handoffs', 'T1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'home.png'), 'png-bytes');
    await writeFile(join(project.store.dir, 'secret.png'), 'nope');

    const ok = await app().request('http://localhost/api/handoffs/T1/home.png');
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('png-bytes');

    for (const path of [
      'T1/..%2Fsecret.png',
      'T1/notes.txt',
      '..%2F..%2Fsecret.png',
      'T1/missing.png',
    ]) {
      expect((await app().request(`http://localhost/api/handoffs/${path}`)).status).toBe(404);
    }
  });

  it('moves tasks with the shared status rules', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1', status: 'blocked' })]));
    expect(
      (await post('/api/tasks/T1/status', { status: 'planned', note: 'Go with A' })).status,
    ).toBe(200);
    expect((await post('/api/tasks/T1/status', { status: 'building' })).status).toBe(400);
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('planned');
    expect((await project.store.readEvents()).at(-1)?.message).toBe('Go with A');
  });

  it('rejects writes without the CSRF header', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1' })]));
    expect((await post('/api/approve', undefined, {})).status).toBe(403);
    expect((await project.store.readPlan())?.approvedAt).toBeNull();
  });

  it('rejects requests for other hostnames', async () => {
    const res = await app().request('http://evil.example/api/project');
    expect(res.status).toBe(403);
  });

  it('falls back to the app shell for client routes', async () => {
    const res = await app().request('http://localhost/board');
    expect(await res.text()).toContain('id="root"');
  });
});
