import { unwatchFile, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  addComment,
  approvePlan,
  cancelTask,
  closeTask,
  editScope,
  prioritise,
  REQUESTABLE_STATUSES,
  requestChanges,
  scopeVersion,
  setStatus,
} from '../core/actions.js';
import { humanDuration, minutesLeft } from '../core/estimates.js';
import { answerPermission } from '../core/permissions.js';
import { MediaPath } from '../core/schema.js';
import type { Store } from '../core/store.js';
import { CSRF_HEADER, type ProjectSnapshot } from './api.js';

export const DEFAULT_PORT = 4777;
const PORT_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 100;
const WATCHED_FILES = ['tasks.json', 'scope.md', 'events.jsonl', 'permissions.json', 'report.md'];

const CommentBody = z.object({ body: z.string() });
const PermissionBody = z.object({ allow: z.boolean() });
const ScopeBody = z.object({
  markdown: z.string().min(1),
  base: z.string(),
  summary: z.string().optional(),
});
const StatusBody = z.object({ status: z.enum(REQUESTABLE_STATUSES), note: z.string().optional() });

export function createBoardApp(store: Store, projectRoot: string, webRoot: string): Hono {
  const app = new Hono();

  // The board is local-only. Reject requests that arrive under another hostname
  // (DNS rebinding), and require a custom header on writes, which cross-site pages
  // can't send without a CORS preflight we never grant.
  app.use('/api/*', async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return c.text('Forbidden', 403);
    if (c.req.method !== 'GET' && c.req.header(CSRF_HEADER) !== '1')
      return c.text('Forbidden', 403);
    await next();
  });

  app.get('/api/project', async (c) =>
    c.json<ProjectSnapshot>({
      name: basename(projectRoot),
      scope: (await store.readScope()) ?? null,
      scopeVersion: scopeVersion(await store.readScope()),
      plan: (await store.readPlan()) ?? null,
      events: await store.readEvents(),
      permissions: await store.readPendingPermissions(),
      report: (await store.readReport()) ?? null,
      buildLeft: await buildLeft(store),
    }),
  );

  app.post('/api/approve', async (c) => {
    const result = await approvePlan(store);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/comments', async (c) => {
    const body = await readBody(c.req.raw);
    if (body === undefined) return c.json({ ok: false, message: 'Expected { body }' }, 400);
    const result = await addComment(store, c.req.param('id'), body);
    return c.json(result, result.ok ? 201 : 400);
  });

  app.post('/api/tasks/:id/close', async (c) => {
    const result = await closeTask(store, c.req.param('id'));
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const result = await cancelTask(store, c.req.param('id'));
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/status', async (c) => {
    const parsed = StatusBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, message: 'Expected { status, note? }' }, 400);
    const result = await setStatus(store, c.req.param('id'), parsed.data.status, parsed.data.note);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.put('/api/scope', async (c) => {
    const parsed = ScopeBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ ok: false, message: 'Expected { markdown, base, summary? }' }, 400);
    const { markdown, base, summary } = parsed.data;
    const result = await editScope(store, markdown, { base, ...(summary && { summary }) });
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/next', async (c) => {
    const result = await prioritise(store, c.req.param('id'));
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/permission', async (c) => {
    const parsed = PermissionBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, message: 'Expected { allow }' }, 400);
    const result = await answerPermission(store, c.req.param('id'), parsed.data.allow);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/tasks/:id/request-changes', async (c) => {
    const body = await readBody(c.req.raw);
    if (body === undefined) return c.json({ ok: false, message: 'Expected { body }' }, 400);
    const result = await requestChanges(store, c.req.param('id'), body);
    return c.json(result, result.ok ? 200 : 409);
  });

  // Screenshots. Paths are validated against the media path format, so nothing
  // outside .dazza/media is reachable.
  app.get('/api/media/:scope/:file', async (c) => {
    const path = `${c.req.param('scope')}/${c.req.param('file')}`;
    if (!MediaPath.safeParse(path).success) return c.notFound();
    try {
      const image = await readFile(store.mediaFile(path));
      return c.body(image, 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
    } catch {
      return c.notFound();
    }
  });

  // Pushes a `change` event whenever project files change, from any process
  // (the chat, the MCP server the agent runs, or someone editing by hand).
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const onChange = debounce(
        () => void stream.writeSSE({ event: 'change', data: '' }),
        DEBOUNCE_MS,
      );
      const paths = WATCHED_FILES.map((file) => join(store.dir, file));
      for (const path of paths) {
        // Unref'd so an open browser tab never keeps the CLI alive.
        watchFile(path, { interval: POLL_INTERVAL_MS }, onChange).unref();
      }

      await new Promise<void>((resolve) => stream.onAbort(resolve));
      for (const path of paths) unwatchFile(path, onChange);
    }),
  );

  // Unknown API paths are errors, not app pages.
  app.all('/api/*', (c) => c.notFound());

  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));

  return app;
}

export interface RunningBoard {
  url: string;
  close(): void;
}

/** Serve the board on the first free port from `DEFAULT_PORT`. */
export async function startBoard(store: Store, projectRoot: string): Promise<RunningBoard> {
  const app = createBoardApp(store, projectRoot, defaultWebRoot());

  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_ATTEMPTS; port++) {
    try {
      const server = await listen(app, port);
      return {
        url: `http://localhost:${port}`,
        close: () => {
          server.close();
          // Open SSE streams would otherwise hold the server (and the CLI) open.
          if ('closeAllConnections' in server) server.closeAllConnections();
        },
      };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw new Error(`No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_ATTEMPTS - 1}`);
}

/** The built web app ships next to the bundled CLI in `dist/web`. */
function defaultWebRoot(): string {
  return fileURLToPath(new URL('./web', import.meta.url));
}

function listen(app: Hono, port: number): Promise<ReturnType<typeof serve>> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(server));
    server.once('error', reject);
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

async function readBody(request: Request): Promise<string | undefined> {
  const parsed = CommentBody.safeParse(await request.json().catch(() => undefined));
  return parsed.success ? parsed.data.body : undefined;
}

async function buildLeft(store: Store): Promise<string | null> {
  const plan = await store.readPlan();
  const minutes = plan ? minutesLeft(plan) : 0;
  return minutes > 0 ? humanDuration(minutes) : null;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
