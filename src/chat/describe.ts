import { basename } from 'node:path';
import { nextTask, progress } from '../core/plan.js';
import type { Plan } from '../core/schema.js';
import { McpTools } from '../mcp/server.js';
import { paint } from './style.js';

/** What to tell the user when they open `dazza`, based on where the project is at. */
export function greeting(plan: Plan | undefined, hasConversation = false): string {
  if (!plan) {
    return hasConversation
      ? 'Picking up where we left off on the scope.'
      : "New project. Tell me what we're building, whenever you're ready.";
  }

  const { done, total } = progress(plan);
  if (!plan.approvedAt) {
    return `Plan drafted: ${total} tasks, waiting on your approval. Review .dazza/scope.md, then /approve — or tell me what to change.`;
  }
  if (done === total) return `All ${total} tasks done. Nice.`;

  const next = nextTask(plan);
  return `${done}/${total} tasks done.${next ? ` Next up: ${next.id} ${next.title}.` : ''}`;
}

/** The task list shown after the plan is saved, so the user can see what they're approving. */
export function planCard(plan: Plan, wasApproved: boolean): string {
  const title = wasApproved
    ? `Plan revised · ${plan.tasks.length} tasks · needs your re-approval`
    : `Plan saved · ${plan.tasks.length} tasks`;
  const width = Math.max(...plan.tasks.map((task) => task.id.length));
  const tasks = plan.tasks.map((task) => `  ${paint.dim(task.id.padEnd(width))}  ${task.title}`);
  const footer = paint.dim('  Full scope in .dazza/scope.md · /approve when you’re happy');
  return [`${paint.green('✔')} ${paint.bold(title)}`, ...tasks, footer].join('\n');
}

/** A short present-tense label for a tool call, shown next to the spinner. */
export function describeTool(tool: string, input: unknown): string {
  const path = pathOf(input);
  switch (tool) {
    case McpTools.savePlan:
      return 'Writing up the plan';
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
