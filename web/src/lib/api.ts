import { type ActionResponse, CSRF_HEADER, type ProjectSnapshot } from '../../../src/board/api.js';

export type { Event, Plan, Subtask, Task, TaskStatus } from '../../../src/core/schema.js';
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

const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

async function post(path: string, body?: unknown): Promise<ActionResponse> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return res.json() as Promise<ActionResponse>;
}
