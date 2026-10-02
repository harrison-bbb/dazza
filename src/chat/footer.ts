import type { Plan, Task } from '../core/schema.js';
import type { ModelOption } from '../providers/types.js';

/**
 * The line under the prompt, as Claude Code and Codex keep one: the model,
 * how much room the conversation has left, and what's waiting on the user,
 * so none of it needs a command to find out.
 */
export interface FooterState {
  /** The model's short name, once known. */
  model?: string | undefined;
  /** How full the conversation is, once Dazza has replied. */
  context?: { tokens?: number; window: number } | undefined;
  plan?: Plan | undefined;
  /** Tasks waiting on the user's OK for a command. */
  permissions?: Record<string, unknown> | undefined;
}

export function footerText({ model, context, plan, permissions = {} }: FooterState): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (context?.tokens !== undefined) {
    const left = Math.max(0, 100 - Math.round((context.tokens / context.window) * 100));
    parts.push(`${left}% context left`);
  }
  if (plan) {
    const review = plan.tasks.filter((t) => t.status === 'review');
    const asking = plan.tasks.filter((t) => t.status === 'blocked' && permissions[t.id]);
    const blocked = plan.tasks.filter((t) => t.status === 'blocked' && !permissions[t.id]);
    if (review.length > 0) parts.push(`${ids(review)} to review`);
    if (asking.length > 0)
      parts.push(`${ids(asking)} ${asking.length === 1 ? 'asks' : 'ask'} to run a command`);
    if (blocked.length > 0)
      parts.push(`${ids(blocked)} ${blocked.length === 1 ? 'needs' : 'need'} you`);
  }
  parts.push('? for shortcuts');
  return parts.join(' · ');
}

/** "T2", "T2 and T5", or "3 tasks" when there are more. */
function ids(tasks: Task[]): string {
  if (tasks.length <= 2) return tasks.map((t) => t.id).join(' and ');
  return `${tasks.length} tasks`;
}

/**
 * A model's name, short enough for the footer. "Default" says which model it
 * is in its description ("Opus 5.5 for complex work"), so that's used.
 */
export function modelLabel(model: ModelOption): string {
  if (/default/i.test(model.id)) {
    const named = /\b(Opus|Sonnet|Haiku|Fable|GPT[\w.-]*)\s*[\d.]*/i.exec(model.description);
    if (named) return named[0].trim();
  }
  return model.name;
}
