import { z } from 'zod';

/** On-disk format version for everything under `.dazza/`. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

const TaskId = z.string().regex(/^T\d+$/, 'Task ids look like "T1"');
const SubtaskId = z.string().regex(/^T\d+\.\d+$/, 'Subtask ids look like "T1.2"');
const Timestamp = z.iso.datetime();

/**
 * Work item lifecycle. Dazza moves items through planned → building → review (or
 * blocked); only the user moves them to closed or cancelled.
 */
export const TaskStatus = z.enum([
  'backlog',
  'planned',
  'building',
  'review',
  'blocked',
  'cancelled',
  'closed',
]);

/** Statuses only the user can set. */
export const USER_STATUSES: readonly TaskStatus[] = ['closed', 'cancelled'];

/** Work that is finished one way or another. */
export const FINAL_STATUSES: readonly TaskStatus[] = ['closed', 'cancelled'];

export const Subtask = z.object({
  id: SubtaskId,
  title: z.string().min(1),
  description: z.string().default(''),
  status: TaskStatus.default('planned'),
});

export const Task = z
  .object({
    id: TaskId,
    title: z.string().min(1),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    subtasks: z.array(Subtask).default([]),
    dependsOn: z.array(TaskId).default([]),
    status: TaskStatus.default('planned'),
  })
  .refine((task) => task.subtasks.every((s) => s.id.startsWith(`${task.id}.`)), {
    message: 'Subtask ids must be prefixed by their parent task id',
    path: ['subtasks'],
  });

export const Plan = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    approvedAt: Timestamp.nullable().default(null),
    tasks: z.array(Task),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const task of plan.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate task id ${task.id}`, path: ['tasks'] });
      }
      ids.add(task.id);
    }
    for (const task of plan.tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            message: `${task.id} depends on unknown task ${dep}`,
            path: ['tasks'],
          });
        }
      }
    }
  });

export const EventType = z.enum([
  'plan_created',
  'plan_approved',
  'task_started',
  'task_progress',
  'task_blocked',
  'task_submitted',
  'task_approved',
  'task_rejected',
  'task_cancelled',
  'scope_change_proposed',
  'comment',
]);

export const Actor = z.enum(['user', 'dazza']);

export const Event = z.object({
  at: Timestamp,
  type: EventType,
  /** Who did it: the user (terminal, board, messages) or Dazza. */
  actor: Actor.default('dazza'),
  /** The task or subtask this is about. */
  taskId: z.union([TaskId, SubtaskId]).optional(),
  message: z.string(),
});

export type TaskStatus = z.infer<typeof TaskStatus>;
export type Actor = z.infer<typeof Actor>;
export type Subtask = z.infer<typeof Subtask>;
export type Task = z.infer<typeof Task>;
export type Plan = z.infer<typeof Plan>;
export type EventType = z.infer<typeof EventType>;
export type Event = z.infer<typeof Event>;
/** An event as written, before defaults are applied. */
export type EventInput = z.input<typeof Event>;
