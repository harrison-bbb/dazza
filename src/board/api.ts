import type { Event, Plan } from '../core/schema.js';

/**
 * The board's HTTP contract, shared by the server and the web app.
 * Type-only so the browser bundle never pulls in server code.
 */
export interface ProjectSnapshot {
  name: string;
  scope: string | null;
  /** Fingerprint of the scope as sent, so an edit can say what it was based on. */
  scopeVersion: string;
  plan: Plan | null;
  events: Event[];
  /** The close-out or progress report, once Dazza has written one. */
  report: string | null;
  /** Roughly how much building is left, e.g. "about 2 hours", from task sizes. */
  buildLeft: string | null;
  /** Commands tasks are waiting on the user's OK to run, by task id. */
  permissions: Record<string, { command: string; why: string }>;
}

export interface ActionResponse {
  ok: boolean;
  message: string;
}

/** Header every write must carry; see the CSRF note in server.ts. */
export const CSRF_HEADER = 'x-dazza';
