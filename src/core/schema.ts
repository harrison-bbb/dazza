import { z } from 'zod';

/** On-disk format version for everything under `.dazza/`. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

const TaskId = z.string().regex(/^T\d+$/, 'Task ids look like "T1"');
const SubtaskId = z.string().regex(/^T\d+\.\d+$/, 'Subtask ids look like "T1.2"');
const Timestamp = z.iso.datetime();

/** A screenshot in `.dazza/media/`, e.g. "T3/login-desktop.png" or "project/home.png". */
export const MediaPath = z
  .string()
  .regex(
    /^(T\d+|project)\/[\w.-]+\.png$/,
    'Screenshots are referenced like "T3/login-desktop.png"',
  );

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

/** Work that is finished one way or another. */
export const FINAL_STATUSES: readonly TaskStatus[] = ['closed', 'cancelled'];

export const Subtask = z.object({
  id: SubtaskId,
  title: z.string().min(1),
  description: z.string().default(''),
  status: TaskStatus.default('planned'),
});

/** What Dazza hands over when it submits a task for review. */
export const Handoff = z.object({
  summary: z.string().min(1),
  /** Steps the user can follow to check the work themselves. */
  howToVerify: z.array(z.string().min(1)).default([]),
  branch: z.string().optional(),
  /** The worktree it was built in, where the user can try it before approving. */
  worktree: z.string().optional(),
  /** The branch the task was built on top of, e.g. "main". */
  baseBranch: z.string().optional(),
  /** The commit holding the submitted work. */
  commit: z.string().optional(),
  filesChanged: z.number().int().nonnegative().optional(),
  /** Automated checks Dazza ran, e.g. tests, lint, build. */
  checks: z.array(z.object({ name: z.string().min(1), passed: z.boolean() })).default([]),
  /** Screenshots of the finished work, when it has a UI worth showing. */
  screenshots: z.array(MediaPath).default([]),
  submittedAt: Timestamp,
});

/**
 * Roughly how big a task is, in the builder's time: S about 20 minutes, M about
 * 45, L about 90. Enough to say what a change costs and how much is left.
 */
export const TaskSize = z.enum(['S', 'M', 'L']);
export const SIZE_MINUTES: Record<z.infer<typeof TaskSize>, number> = { S: 20, M: 45, L: 90 };

export const Task = z
  .object({
    id: TaskId,
    title: z.string().min(1),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    subtasks: z.array(Subtask).default([]),
    dependsOn: z.array(TaskId).default([]),
    status: TaskStatus.default('planned'),
    size: TaskSize.optional(),
    handoff: Handoff.optional(),
  })
  .refine((task) => task.subtasks.every((s) => s.id.startsWith(`${task.id}.`)), {
    message: 'Subtask ids must be prefixed by their parent task id',
    path: ['subtasks'],
  });

/** A stage the user can see and try: a few tasks that together deliver something. */
export const Milestone = z.object({
  id: z.string().regex(/^M\d+$/, 'Milestone ids look like "M1"'),
  title: z.string().min(1),
  /** What the user can do once it's reached, e.g. "Clients can book and pay for walks". */
  goal: z.string().min(1),
  tasks: z.array(TaskId).min(1),
});

export const Plan = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    approvedAt: Timestamp.nullable().default(null),
    /** Tasks in priority order: the builder takes the first one that's ready. */
    tasks: z.array(Task),
    milestones: z.array(Milestone).default([]),
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
    const placed = new Map<string, string>();
    for (const milestone of plan.milestones) {
      for (const id of milestone.tasks) {
        if (!ids.has(id)) {
          ctx.addIssue({
            code: 'custom',
            message: `${milestone.id} lists unknown task ${id}`,
            path: ['milestones'],
          });
        }
        const other = placed.get(id);
        if (other) {
          ctx.addIssue({
            code: 'custom',
            message: `${id} is in both ${other} and ${milestone.id}; a task belongs to one milestone`,
            path: ['milestones'],
          });
        }
        placed.set(id, milestone.id);
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
  'task_edited',
  'task_added',
  'task_moved',
  'scope_change_proposed',
  /** An agreed change to the scope, recorded in its change log. */
  'scope_changed',
  /** All of a milestone's tasks are closed. The message starts with its id: "M2: …". */
  'milestone_reached',
  /** The close-out (or progress) report was written. */
  'report_written',
  'comment',
  /** Dazza's guard stopped something the builder tried, or let it through with the user's OK. */
  'guarded',
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
  /** Screenshots shared with this event, e.g. on a comment or a question. */
  images: z.array(MediaPath).optional(),
});

export type TaskStatus = z.infer<typeof TaskStatus>;
export type Actor = z.infer<typeof Actor>;
export type Subtask = z.infer<typeof Subtask>;
export type Task = z.infer<typeof Task>;
export type Handoff = z.infer<typeof Handoff>;
export type Plan = z.infer<typeof Plan>;
export type Milestone = z.infer<typeof Milestone>;
export type TaskSize = z.infer<typeof TaskSize>;
export type EventType = z.infer<typeof EventType>;
export type Event = z.infer<typeof Event>;
/** An event as written, before defaults are applied. */
export type EventInput = z.input<typeof Event>;
