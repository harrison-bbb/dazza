import { z } from 'zod';
import { isAllowed } from '../core/permissions.js';
import { Store } from '../core/store.js';
import { MCP_SERVER_NAME } from '../mcp/name.js';
import { errorMessage } from '../util/text.js';
import { type Decision, judge, patchedFiles } from './policy.js';

/**
 * `dazza guard`: Claude Code and Codex run this before every tool call (a
 * PreToolUse hook) and do what it says. Reads the call on stdin; answers on stdout.
 * Stays silent to let a call through (the agent CLI's own permission checks then
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
  /** The task this builder is building; tasks can build side by side. */
  taskId?: string,
): Promise<string> {
  try {
    const call = HookInput.parse(JSON.parse(stdin));
    return await answer(new Store(projectRoot), role, call.tool_name, call.tool_input, taskId);
  } catch (error) {
    // Fail closed: an unchecked call doesn't run.
    return refuse(
      `Dazza's guard couldn't check this (${errorMessage(error)}). Try it another way.`,
    );
  }
}

async function answer(
  store: Store,
  role: GuardRole,
  tool: string,
  input: Record<string, unknown>,
  taskId: string | undefined,
): Promise<string> {
  const tasks = (await store.readPlan())?.tasks ?? [];
  const task =
    role !== 'worker'
      ? undefined
      : taskId
        ? tasks.find((t) => t.id === taskId)
        : tasks.find((t) => t.status === 'building');
  const workspace = (task && (await store.readTaskBuild(task.id))?.dir) ?? store.root;
  const decision = judge({ tool, input }, { workspace });
  // The chat using the user's own MCP servers (their email, docs, trackers):
  // headless Claude Code would refuse tools nobody pre-approved, and server
  // names aren't known until the session starts, so the guard approves them.
  if (decision.kind === 'allow' && role === 'manager' && isUserMcp(tool)) return approve();
  if (decision.kind === 'allow') return '';

  // Codex's apply_patch carries the patch as its "command": that's an edit, not a command.
  const command =
    tool !== 'apply_patch' && typeof input.command === 'string' ? input.command.trim() : undefined;
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
  if (tool === 'apply_patch' && typeof input.command === 'string') {
    return `editing ${patchedFiles(input.command).join(', ')}`;
  }
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

function isUserMcp(tool: string): boolean {
  return tool.startsWith('mcp__') && !tool.startsWith(`mcp__${MCP_SERVER_NAME}__`);
}

function approve(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  });
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
