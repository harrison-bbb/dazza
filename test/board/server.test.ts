import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../../src/board/api.js';
import { createBoardApp } from '../../src/board/server.js';
import { makePlan, makeTask, SCOPE } from '../fixtures.js';
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

  it('shows a task’s permission request, and records the answer', async () => {
    await project.store.writePlan(makePlan([makeTask({ id: 'T1', status: 'blocked' })]));
    await project.store.updatePermissions('T1', (p) => ({
      ...p,
      pending: { command: 'brew install redis', why: 'Local cache for tests' },
    }));
    const snapshot = (await (
      await app().request('http://localhost/api/project')
    ).json()) as ProjectSnapshot;
    expect(snapshot.permissions).toEqual({
      T1: { command: 'brew install redis', why: 'Local cache for tests' },
    });

    expect((await post('/api/tasks/T1/permission', { allow: 'yes' })).status).toBe(400);
    expect((await post('/api/tasks/T1/permission', { allow: true })).status).toBe(200);
    expect((await project.store.readPermissions('T1')).allowed).toEqual(['brew install redis']);
    expect((await project.store.readPlan())?.tasks[0]?.status).toBe('planned');
  });

  it('saves the user’s edit to the scope, logs it once the plan is approved, and won’t overwrite a newer version', async () => {
    await project.store.writePlan({
      ...makePlan([makeTask({ id: 'T1' })]),
      approvedAt: '2026-09-27T10:00:00Z',
    });
    await project.store.writeScope(SCOPE);
    const snapshot = async () =>
      (await (await app().request('http://localhost/api/project')).json()) as ProjectSnapshot;
    const put = (body: unknown) =>
      app().request('http://localhost/api/scope', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-dazza': '1' },
        body: JSON.stringify(body),
      });
    const { scopeVersion } = await snapshot();

    const thin = await put({ markdown: '## Overview\nJust this', base: scopeVersion });
    expect(thin.status).toBe(409);
    expect(JSON.stringify(await thin.json())).toContain('Keep every section');

    const edited = SCOPE.replace('## Out of scope\nDetails.', '## Out of scope\nNo mobile app.');
    const saved = await put({
      markdown: edited,
      base: scopeVersion,
      summary: 'Ruled out a mobile app',
    });
    expect(saved.status).toBe(200);
    const scope = (await project.store.readScope()) ?? '';
    expect(scope).toContain('No mobile app.');
    expect(scope).toMatch(
      /## Change log\n\n- \*\*v2 · .*\*\*: Ruled out a mobile app\. Why: Edited by you on the board/,
    );
    expect((await project.store.readEvents()).at(-1)).toMatchObject({
      type: 'scope_changed',
      actor: 'user',
    });

    // Someone else's edit since this one was started: refused, not overwritten.
    const stale = await put({ markdown: SCOPE, base: scopeVersion });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toContain('changed while you were editing');
    expect(await project.store.readScope()).toBe(scope);
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

  it('serves screenshots and nothing else', async () => {
    const dir = join(project.store.dir, 'media', 'T1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'home-desktop.png'), 'png-bytes');
    await writeFile(join(project.store.dir, 'secret.png'), 'nope');

    const ok = await app().request('http://localhost/api/media/T1/home-desktop.png');
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('png-bytes');

    for (const path of [
      'T1/..%2F..%2Fsecret.png',
      'T1/notes.txt',
      'etc/passwd.png',
      'T1/missing.png',
    ]) {
      expect((await app().request(`http://localhost/api/media/${path}`)).status).toBe(404);
    }
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
