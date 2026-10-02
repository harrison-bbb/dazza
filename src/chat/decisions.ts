import type { Plan, Task } from '../core/schema.js';
/** A decision waiting on the user: a builder's request to run a command, or work to review. */
export type Decision =
  | { kind: 'permission'; key: string; task: Task; command: string; why: string }
  | { kind: 'review'; key: string; task: Task };

export function decisionsIn(
  plan: Plan | undefined,
  pending: Record<string, { command: string; why: string }>,
): Decision[] {
  if (!plan) return [];
  return plan.tasks.flatMap((task): Decision[] => {
    const request = pending[task.id];
    if (task.status === 'blocked' && request) {
      return [{ kind: 'permission', key: `allow:${task.id}:${request.command}`, task, ...request }];
    }
    if (task.status === 'review') {
      return [
        { kind: 'review', key: `review:${task.id}:${task.handoff?.submittedAt ?? ''}`, task },
      ];
    }
    return [];
  });
}
