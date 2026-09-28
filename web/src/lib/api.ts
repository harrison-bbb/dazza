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

export interface Activity {
  at: string;
  taskId: string;
  kind: 'say' | 'do' | 'status';
  text: string;
}

export async function fetchActivity(taskId: string, limit = 200): Promise<Activity[]> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/activity?limit=${limit}`);
    return res.ok ? ((await res.json()) as Activity[]) : [];
  } catch {
    return [];
  }
}

export interface TaskEdits {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  size?: 'S' | 'M' | 'L';
}
export const editTask = (id: string, changes: TaskEdits) => send('PATCH', task(id), changes);
export const redoTask = (id: string, note: string) => post(`${task(id)}/redo`, { note });
export const buildNext = (id: string) => post(`${task(id)}/next`);
export const answerPermission = (id: string, allow: boolean) =>
  post(`${task(id)}/permission`, { allow });

export interface ScopeVersion {
  id: string;
  at: string;
  label: string;
}

export async function fetchScopeVersions(): Promise<ScopeVersion[]> {
  const res = await fetch('/api/scope/versions');
  return res.ok ? ((await res.json()) as ScopeVersion[]) : [];
}

export async function fetchScopeVersion(id: string): Promise<string | undefined> {
  const res = await fetch(`/api/scope/versions/${encodeURIComponent(id)}`);
  return res.ok ? ((await res.json()) as { markdown: string }).markdown : undefined;
}

export const restoreScopeVersion = (id: string) =>
  post(`/api/scope/versions/${encodeURIComponent(id)}/restore`);

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
