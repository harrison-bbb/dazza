import { type ActionResponse, CSRF_HEADER, type ProjectSnapshot } from '../../../src/board/api.js';

export type { Event, Plan, Subtask, Task, TaskStatus } from '../../../src/core/schema.js';
export type { ProjectSnapshot };

export async function fetchProject(): Promise<ProjectSnapshot> {
  const res = await fetch('/api/project');
  if (!res.ok) throw new Error(`Failed to load project (${res.status})`);
  return res.json() as Promise<ProjectSnapshot>;
}

export function approvePlan(): Promise<ActionResponse> {
  return post('/api/approve');
}

export function addComment(taskId: string, body: string): Promise<ActionResponse> {
  return post(`/api/tasks/${encodeURIComponent(taskId)}/comments`, { body });
}

async function post(path: string, body?: unknown): Promise<ActionResponse> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return res.json() as Promise<ActionResponse>;
}
