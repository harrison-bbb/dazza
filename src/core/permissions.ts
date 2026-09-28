import { type ActionResult, setStatus } from './actions.js';
import type { Store } from './store.js';
import { blockTask } from './work.js';

/**
 * Asking the user before a risky command. The builder asks with the exact
 * command and why; the task waits; the user allows or refuses it (in the chat,
 * on the board, or with a button on their phone). Only that exact command is
 * allowed, and only for that task.
 */

/** The builder asks to run a command the guard wouldn't let through on its own. */
export async function requestPermission(
  store: Store,
  taskId: string,
  command: string,
  why: string,
): Promise<ActionResult> {
  await store.updatePermissions(taskId, (p) => ({
    ...p,
    pending: { command: command.trim(), why },
  }));
  const result = await blockTask(store, taskId, permissionQuestion(command, why));
  return result.ok
    ? {
        ok: true,
        message:
          'Asked. End your turn now, without writing anything else: the task waits for their answer, and you’ll hear it when it resumes.',
      }
    : result;
}

/** The user's answer to a pending request. Puts the task back in the queue either way. */
export async function answerPermission(
  store: Store,
  taskId: string,
  allow: boolean,
  note = '',
): Promise<ActionResult> {
  const { pending } = await store.readPermissions(taskId);
  if (!pending) return { ok: false, message: `${taskId} isn’t waiting on a permission.` };
  await store.updatePermissions(taskId, (p) => ({
    allowed: allow ? [...new Set([...p.allowed, pending.command])] : p.allowed,
  }));
  const answer = allow
    ? `Allowed: you can run \`${pending.command}\`.`
    : `Not allowed: don’t run \`${pending.command}\`. Find another way, or leave it out and say so in your handoff.`;
  const result = await setStatus(
    store,
    taskId,
    'planned',
    note.trim() ? `${answer} ${note.trim()}` : answer,
  );
  return result.ok
    ? {
        ok: true,
        message: allow
          ? `Allowed \`${pending.command}\` for ${taskId}. It’s back in the queue.`
          : `Refused. ${taskId} is back in the queue to find another way.`,
      }
    : result;
}

/** Whether the user has allowed this exact command for this task. */
export async function isAllowed(store: Store, taskId: string, command: string): Promise<boolean> {
  return (await store.readPermissions(taskId)).allowed.includes(command.trim());
}

export function permissionQuestion(command: string, why: string): string {
  return `May I run this?\n\n\`${command}\`\n\nWhy: ${why}`;
}
