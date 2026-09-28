import { basename } from 'node:path';
import { humanDuration, minutesLeft } from '../core/estimates.js';
import { currentMilestone } from '../core/milestones.js';
import { currentTask, nextTask, progress } from '../core/plan.js';
import type { Plan, Task } from '../core/schema.js';
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
  const next = current ? undefined : nextTask(plan);
  const withStatus = (status: Task['status']) => plan.tasks.filter((t) => t.status === status);
  const stage = currentMilestone(plan);
  const left = minutesLeft(plan);
  return [
    `${closed}/${total} tasks closed${left ? ` (${humanDuration(left)} of building left)` : ''}.`,
    stage &&
      `Working towards ${stage.milestone.id} ${stage.milestone.title} (${stage.closed}/${stage.total}).`,
    current && `Building ${current.id} ${current.title}.`,
    waiting(withStatus('review'), 'waiting for your review'),
    waiting(withStatus('blocked'), 'blocked on you'),
    next && `Next up: ${next.id} ${next.title}. Run /build to start.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** "T3 Editor is waiting for your review", or "2 tasks are … (T3, T4)". */
function waiting(tasks: Task[], what: string): string | undefined {
  const [only] = tasks;
  if (!only) return undefined;
  return tasks.length === 1
    ? `${only.id} ${only.title} is ${what}.`
    : `${tasks.length} tasks are ${what} (${tasks.map((t) => t.id).join(', ')}).`;
}

/** The task list shown after the plan is saved, so the user can see what they're approving. */
export function planCard(plan: Plan, wasApproved: boolean, boardUrl: string): string {
  const left = minutesLeft(plan);
  const title = [
    wasApproved ? 'Plan revised' : 'Plan saved',
    `${plan.tasks.length} tasks`,
    left > 0 && `${humanDuration(left)} of building`,
    wasApproved && 'needs your re-approval',
  ]
    .filter(Boolean)
    .join(' · ');
  const width = Math.max(...plan.tasks.map((task) => task.id.length));
  const line = (task: Task) =>
    `  ${paint.dim(task.id.padEnd(width))}  ${task.title}${task.size ? paint.dim(` · ${task.size}`) : ''}`;
  // Grouped by milestone when there are any, so the stages are clear.
  const grouped = plan.milestones.flatMap((m) => [
    `  ${paint.bold(`${m.id} ${m.title}`)} ${paint.dim(`· ${m.goal}`)}`,
    ...plan.tasks.filter((t) => m.tasks.includes(t.id)).map(line),
  ]);
  const placed = new Set(plan.milestones.flatMap((m) => m.tasks));
  const loose = plan.tasks.filter((t) => !placed.has(t.id)).map(line);
  const footer = paint.dim(`  Review it at ${boardUrl} · approve there, here, or with /approve`);
  return [`${paint.green('✔')} ${paint.bold(title)}`, ...grouped, ...loose, footer].join('\n');
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
