import { type ActionResponse, CSRF_HEADER, type ProjectSnapshot } from '../../../src/board/api.js';

export type { Event, Handoff, Plan, Subtask, Task, TaskStatus } from '../../../src/core/schema.js';
export type { ProjectSnapshot };

export async function fetchProject(): Promise<ProjectSnapshot> {
  const res = await fetch('/api/project');
  if (!res.ok) throw new Error(`Failed to load project (${res.status})`);
  return res.json() as Promise<ProjectSnapshot>;
}

export const approvePlan = () => post('/api/approve');
export const closeTask = (id: string) => post(`${task(id)}/close`);
export const cancelTask = (id: string) => post(`${task(id)}/cancel`);
export const requestChanges = (id: string, body: string) =>
  post(`${task(id)}/request-changes`, { body });
export const addComment = (id: string, body: string) => post(`${task(id)}/comments`, { body });
export const setStatus = (id: string, status: 'backlog' | 'planned', note?: string) =>
  post(`${task(id)}/status`, { status, ...(note && { note }) });

export const buildNext = (id: string) => post(`${task(id)}/next`);
export const answerPermission = (id: string, allow: boolean) =>
  post(`${task(id)}/permission`, { allow });

export const saveScope = (markdown: string, base: string, summary?: string) =>
  send('PUT', '/api/scope', { markdown, base, ...(summary && { summary }) });

const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

function post(path: string, body?: unknown): Promise<ActionResponse> {
  return send('POST', path, body);
}

/** Never throws: a failure comes back as a message to show, so buttons never get stuck. */
async function send(method: string, path: string, body?: unknown): Promise<ActionResponse> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => undefined)) as ActionResponse | undefined;
    return json ?? { ok: false, message: `Dazza couldn’t do that (${res.status}).` };
  } catch {
    return { ok: false, message: 'Can’t reach Dazza. Is it still running in your terminal?' };
  }
}
