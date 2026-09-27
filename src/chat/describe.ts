import { basename } from 'node:path';
import { currentTask, nextTask, progress } from '../core/plan.js';
import type { Plan } from '../core/schema.js';
import { McpTools } from '../mcp/server.js';
import { paint } from './style.js';

export interface GreetingContext {
  /** There's an earlier conversation with Dazza in this project. */
  hasConversation?: boolean;
  /** The code already in the directory, described in a few words. */
  codebase?: string;
}

/** What to tell the user when they open `dazza`, based on where the project is at. */
export function greeting(plan: Plan | undefined, context: GreetingContext = {}): string {
  if (!plan) {
    if (context.hasConversation) return 'Picking up where we left off.';
    if (context.codebase) return `This is ${context.codebase}. What do you want to work on?`;
    return "New project. Tell me what we're building, whenever you're ready.";
  }

  const { closed, total } = progress(plan);
  if (!plan.approvedAt) {
    return `Plan drafted: ${total} tasks, waiting on your approval. Review it on the board (/board), then approve — or tell me what to change.`;
  }
  if (closed === total) return `All ${total} tasks closed. Nice.`;

  const current = currentTask(plan);
  if (current) return `${closed}/${total} tasks closed. Building ${current.id} ${current.title}.`;
  const next = nextTask(plan);
  return `${closed}/${total} tasks closed.${next ? ` Next up: ${next.id} ${next.title}.` : ''}`;
}

/** The task list shown after the plan is saved, so the user can see what they're approving. */
export function planCard(plan: Plan, wasApproved: boolean, boardUrl: string): string {
  const title = wasApproved
    ? `Plan revised · ${plan.tasks.length} tasks · needs your re-approval`
    : `Plan saved · ${plan.tasks.length} tasks`;
  const width = Math.max(...plan.tasks.map((task) => task.id.length));
  const tasks = plan.tasks.map((task) => `  ${paint.dim(task.id.padEnd(width))}  ${task.title}`);
  const footer = paint.dim(`  Review it at ${boardUrl} · approve there or with /approve`);
  return [`${paint.green('✔')} ${paint.bold(title)}`, ...tasks, footer].join('\n');
}

/** A short present-tense label for a tool call, shown next to the spinner. */
export function describeTool(tool: string, input: unknown): string {
  const path = pathOf(input);
  switch (tool) {
    case McpTools.savePlan:
      return 'Writing up the plan';
    case McpTools.updateItem:
    case McpTools.addTask:
    case McpTools.addSubtask:
    case McpTools.setStatus:
      return 'Updating the board';
    case McpTools.comment:
      return 'Leaving a comment';
    case McpTools.screenshot:
      return 'Taking a screenshot';
    case 'Read':
      return path ? `Reading ${basename(path)}` : 'Reading';
    case 'Glob':
    case 'Grep':
      return 'Looking around the codebase';
    default:
      return 'Working';
  }
}

function pathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('file_path' in input)) return undefined;
  return typeof input.file_path === 'string' ? input.file_path : undefined;
}
