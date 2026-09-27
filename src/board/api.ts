import type { Event, Plan } from '../core/schema.js';

/**
 * The board's HTTP contract, shared by the server and the web app.
 * Type-only so the browser bundle never pulls in server code.
 */
export interface ProjectSnapshot {
  name: string;
  scope: string | null;
  plan: Plan | null;
  events: Event[];
}

export interface ActionResponse {
  ok: boolean;
  message: string;
}

/** Header every write must carry; see the CSRF note in server.ts. */
export const CSRF_HEADER = 'x-dazza';
