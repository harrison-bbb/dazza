import { relative } from 'node:path';
import { McpTools } from '../mcp/server.js';
import type { BuildEvent } from './builder.js';
import { clock } from './errors.js';
import type { Activity } from './schema.js';
import type { Store } from './store.js';

/** Turns build events into activity lines, and keeps them. */
export class ActivityRecorder {
  /** Each task's worktree, so paths read relative to it. */
  private readonly dirs = new Map<string, string>();

  constructor(private readonly store: Store) {}

  async record(event: BuildEvent, now = new Date()): Promise<void> {
    if (event.type === 'task_started' && event.dir) this.dirs.set(event.task.id, event.dir);
    const entry = this.describe(event);
    if (!entry || !('task' in event)) return;
    await this.store
      .appendActivity({ at: now.toISOString(), taskId: event.task.id, ...entry })
      .catch(() => {});
  }

  private describe(event: BuildEvent): Pick<Activity, 'kind' | 'text'> | undefined {
    switch (event.type) {
      case 'task_started':
        return {
          kind: 'status',
          text: event.resumed ? 'Picked the task back up' : 'Started building',
        };
      case 'task_finished':
        return {
          kind: 'status',
          text:
            event.outcome === 'review'
              ? 'Handed over for your review'
              : event.outcome === 'blocked'
                ? 'Stopped: waiting on you'
                : 'Paused',
        };
      case 'waiting':
        return {
          kind: 'status',
          text:
            event.reason === 'usage_limit'
              ? `Waiting for the usage limit to reset (${clock(event.until)})`
              : 'Waiting for the service to settle',
        };
      case 'retrying':
        return { kind: 'status', text: event.reason };
      case 'agent': {
        const agent = event.event;
        if (agent.type === 'text') {
          const text = agent.text.replace(/\s+/g, ' ').trim();
          return text
            ? { kind: 'say', text: text.length > 400 ? `${text.slice(0, 399)}…` : text }
            : undefined;
        }
        if (agent.type === 'tool_use') {
          const text = step(agent.tool, agent.input, this.dirs.get(event.task.id));
          return text ? { kind: 'do', text } : undefined;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }
}

/** One tool call, as a step a person would describe. Plumbing is left out. */
function step(tool: string, input: unknown, dir: string | undefined): string | undefined {
  const field = (name: string) => {
    const value =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)[name]
        : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const path = (name = 'file_path') => {
    const value = field(name);
    return value && dir ? relative(dir, value) || '.' : value;
  };
  switch (tool) {
    case 'Write':
      return `Wrote ${path()}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${path()}`;
    case 'NotebookEdit':
      return `Edited ${path('notebook_path')}`;
    case 'Read':
      return `Read ${path()}`;
    case 'Bash':
    case 'Monitor': {
      const command = (field('command') ?? '').replace(/\s+/g, ' ').trim();
      return `Ran ${command.length > 160 ? `${command.slice(0, 159)}…` : command}`;
    }
    case 'Grep':
    case 'Glob':
      return 'Searched the code';
    case 'WebFetch':
    case 'WebSearch':
      return 'Looked something up online';
    case McpTools.updateSubtask:
      return `${field('status') === 'closed' ? 'Finished' : 'Started'} ${field('id')}`;
    case McpTools.screenshot:
      return 'Took a screenshot';
    case McpTools.comment:
      return 'Left a comment';
    case McpTools.block:
      return 'Asked you a question';
    case McpTools.askPermission:
      return `Asked to run ${field('command')}`;
    case McpTools.submit:
      return 'Handing over';
    default:
      return undefined;
  }
}
