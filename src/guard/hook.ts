import { z } from 'zod';
import { isAllowed } from '../core/permissions.js';
import { Store } from '../core/store.js';
import { type Decision, judge } from './policy.js';

/**
 * `dazza guard`: Claude Code runs this before every tool call (a PreToolUse
 * hook) and does what it says. Reads the call on stdin; answers on stdout.
 * Stays silent to let a call through (Claude Code's own permission mode then
 * applies as usual), and refuses with a reason the agent reads otherwise.
 */

const HookInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});

export type GuardRole = 'manager' | 'worker';

export async function runGuard(
  projectRoot: string,
  role: GuardRole,
  stdin: string,
): Promise<string> {
  try {
    const call = HookInput.parse(JSON.parse(stdin));
    return await answer(new Store(projectRoot), role, call.tool_name, call.tool_input);
  } catch (error) {
    // Fail closed: an unchecked call doesn't run.
    return refuse(
      `Dazza's guard couldn't check this (${error instanceof Error ? error.message : String(error)}). Try it another way.`,
    );
  }
}

async function answer(
  store: Store,
  role: GuardRole,
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  const task =
    role === 'worker'
      ? (await store.readPlan())?.tasks.find((t) => t.status === 'building')
      : undefined;
  const workspace = (task && (await store.readTaskBuild(task.id))?.dir) ?? store.root;
  const decision = judge({ tool, input }, { workspace });
  if (decision.kind === 'allow') return '';

  const command = typeof input.command === 'string' ? input.command.trim() : undefined;
  if (decision.kind === 'ask' && task && command && (await isAllowed(store, task.id, command))) {
    await log(store, task?.id, `Ran \`${command}\` with your OK.`);
    return '';
  }
  await log(store, task?.id, guardNote(decision, command ?? describe(tool, input)));
  return refuse(explain(decision));
}

/** What the agent is told, so it takes the right next step. */
function explain(decision: Exclude<Decision, { kind: 'allow' }>): string {
  return decision.kind === 'ask'
    ? `Dazza's guard: this needs the user's OK first. ${decision.reason} ` +
        'If the task truly needs it, call ask_permission with the exact command and why, then stop. ' +
        'Otherwise, find another way that stays inside this task.'
    : `Dazza's guard: not allowed. ${decision.reason} Don't try to get around this. ` +
        'If the task can’t be done without it, call block and explain what you need.';
}

function guardNote(decision: Exclude<Decision, { kind: 'allow' }>, what: string): string {
  return decision.kind === 'ask'
    ? `Held back \`${what}\` to ask you first: ${decision.reason}`
    : `Stopped \`${what}\`: ${decision.reason}`;
}

function describe(tool: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.path ?? input.notebook_path;
  return typeof path === 'string' ? `${tool} ${path}` : tool;
}

async function log(store: Store, taskId: string | undefined, message: string): Promise<void> {
  await store
    .appendEvent({
      at: new Date().toISOString(),
      type: 'guarded',
      actor: 'dazza',
      message,
      ...(taskId && { taskId }),
    })
    .catch(() => {});
}

function refuse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}
