import { basename } from 'node:path';
import { humanDuration, minutesLeft, type TimeLeft } from '../core/estimates.js';
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
  /** There's an earlier conversation `/continue` can go back to. */
  canContinue?: boolean;
  /** For Slack or Telegram: no terminal commands, and the board is on their computer. */
  remote?: boolean;
  /** The build's time left (see projectEstimate); without it, a rough one from task sizes. */
  left?: TimeLeft;
  /** Tasks start on top of work in review (/build-ahead). */
  ahead?: boolean;
}

/** What to tell the user when they open `dazza`, based on where the project is at. */
export function greeting(plan: Plan | undefined, context: GreetingContext = {}): string {
  const opening = greetingFor(plan, context);
  // A new conversation, with an earlier one to go back to.
  if (!context.canContinue || context.remote || context.hasConversation) return opening;
  return plan
    ? `${opening}\n${paint.dim('New conversation. /continue picks up the last one.')}`
    : 'New conversation. We were talking last time: /continue picks that back up, or tell me what we’re building.';
}

function greetingFor(plan: Plan | undefined, context: GreetingContext): string {
  if (!plan) {
    if (context.remote) return NO_PLAN;
    if (context.hasConversation)
      return 'Picking up where we left off: carry on, or /new to start fresh.';
    if (context.codebase) return `This is ${context.codebase}. What do you want to work on?`;
    return (
      'New project. How this goes: you tell me what you want and who it’s for, I ask a few rounds of questions, ' +
      'then I play back what I’ll build before I write up the plan. It usually takes 5 to 10 minutes.\n' +
      'So, what are we building?'
    );
  }

  const { closed, total } = progress(plan);
  const remote = context.remote === true;
  if (!plan.approvedAt) {
    return remote
      ? `Plan drafted: ${total} tasks, waiting on your approval. Look it over on the board on your computer, then tell me to approve it, or what to change.`
      : `Plan drafted: ${total} tasks, waiting on your approval. Look it over with /scope, then /approve, or tell me what to change.`;
  }
  if (closed === total) {
    return remote
      ? `All ${total} tasks closed. The close-out report is on the board.`
      : `All ${total} tasks closed. The close-out report is on the board (/dashboard). Tell me what’s next, or /report to write it again.`;
  }

  const current = currentTask(plan);
  const next = current ? undefined : nextTask(plan, [], context.ahead ?? false);
  const withStatus = (status: Task['status']) => plan.tasks.filter((t) => t.status === status);
  const stage = currentMilestone(plan);
  const left = context.left?.wall ?? minutesLeft(plan);
  return [
    `${closed}/${total} tasks closed${left ? ` (${humanDuration(left)} of building left)` : ''}.`,
    stage &&
      `Working towards ${stage.milestone.id} ${stage.milestone.title} (${stage.closed}/${stage.total}).`,
    current && `Building ${current.id} ${current.title}.`,
    waiting(withStatus('review'), 'waiting for your review'),
    waiting(withStatus('blocked'), 'blocked on you'),
    withStatus('review').length + withStatus('blocked').length > 0 &&
      (remote ? 'Their messages are above.' : '/review to go through them.'),
    next &&
      `Next up: ${next.id} ${next.title}. ${remote ? 'Tell me to start building.' : 'Run /build to start.'}`,
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

/** What every command says before there's a plan. */
export const NO_PLAN = 'No plan yet. Tell me what you want to build and I’ll scope it with you.';

/** The task list shown after the plan is saved, so the user can see what they're approving. */
export function planCard(
  plan: Plan,
  wasApproved: boolean,
  boardUrl: string,
  /** Calibrated times (see timeLeft and milestoneTimes); without them, rough ones from sizes. */
  times?: { wall: number; milestones: { id: string; title: string; minutes: number }[] },
): string {
  const left = times?.wall ?? minutesLeft(plan);
  const title = [
    plan.problems.length > 0
      ? 'Draft plan, still being finished'
      : wasApproved
        ? 'Plan revised'
        : 'Plan saved',
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
  // When there's first something to try: what makes a long plan feel short.
  const first = times?.milestones[0];
  const soonest =
    first && plan.milestones.length > 1 && first.minutes > 0
      ? `  First thing you can try: ${first.id} ${first.title}, ${humanDuration(first.minutes)} after you start`
      : undefined;
  const footer = paint.dim(`  Review it at ${boardUrl} · approve there, here, or with /approve`);
  return [
    `${paint.green('✔')} ${paint.bold(title)}`,
    ...(soonest ? [soonest] : []),
    ...grouped,
    ...loose,
    footer,
  ].join('\n');
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
    case 'Edit':
    case 'NotebookEdit':
      return path ? `Editing ${basename(path)}` : 'Editing';
    case 'Write':
      return path ? `Writing ${basename(path)}` : 'Writing a file';
    case 'Bash':
    case 'Monitor': {
      const command = commandOf(input);
      return command
        ? `Running ${command.length > 48 ? `${command.slice(0, 47)}…` : command}`
        : 'Running a command';
    }
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up';
    case McpTools.updateSubtask:
      return 'Ticking off a subtask';
    case McpTools.checkMessages:
      return 'Checking your messages';
    case McpTools.block:
      return 'Asking you something';
    case McpTools.askPermission:
      return 'Asking to run a command';
    case McpTools.submit:
      return 'Handing it over';
    default:
      return 'Working';
  }
}

function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined;
  return typeof input.command === 'string' ? input.command.split('\n')[0]?.trim() : undefined;
}

function pathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('file_path' in input)) return undefined;
  return typeof input.file_path === 'string' ? input.file_path : undefined;
}

/**
 * What to say on the way out, as Codex does: what's still waiting on the user,
 * and how to pick the conversation back up.
 */
export function farewell(
  plan: Plan | undefined,
  { conversation }: { conversation: boolean },
): string {
  const lines: string[] = [];
  if (plan) {
    const review = plan.tasks.filter((t) => t.status === 'review');
    const blocked = plan.tasks.filter((t) => t.status === 'blocked');
    if (review.length > 0) {
      lines.push(`Waiting for your review: ${review.map((t) => `${t.id} ${t.title}`).join(', ')}.`);
    }
    if (blocked.length > 0) {
      lines.push(`Waiting on your answer: ${blocked.map((t) => `${t.id} ${t.title}`).join(', ')}.`);
    }
  }
  if (conversation) lines.push(paint.dim('`dazza --continue` picks this conversation back up.'));
  return lines.join('\n');
}
