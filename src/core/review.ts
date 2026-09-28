import type { Milestone, Task } from './schema.js';

/**
 * A floor under plan quality, checked when the manager saves a plan. The
 * builder works from the plan alone, so a one-line task gets a guessed build.
 * These are cheap, mechanical checks; the prompt asks for the real depth.
 */

/** Sections every scope has, in the manager prompt's words. */
export const SCOPE_SECTIONS = [
  'Overview',
  'Users',
  'Goals',
  'User flows',
  'In scope',
  'Out of scope',
  'Tech stack',
  'Structure & conventions',
  'Security',
  'Decisions & assumptions',
  'Risks & open questions',
  'What I’ll need from you',
] as const;

/** Enough for what, the details, the approach and the boundaries; one-liners fall short. */
export const MIN_TASK_DESCRIPTION = 300;
/** Enough for what to build, where, and how you'd know it's done. */
export const MIN_SUBTASK_DESCRIPTION = 80;
const MIN_SUBTASKS = 2;
const MIN_CRITERIA = 2;
/** Plans this big get milestones. */
const MILESTONE_THRESHOLD = 4;
/** Enough to act on without burying the manager in a wall of errors. */
const MAX_REPORTED = 12;

/** What's missing from a plan, as instructions to fix it. Empty when it passes. */
export function reviewPlan(scope: string, tasks: Task[], milestones: Milestone[] = []): string[] {
  const problems: string[] = [];

  const missing = missingSections(scope);
  if (missing.length > 0) {
    problems.push(`The scope is missing sections: ${missing.map((s) => `## ${s}`).join(', ')}.`);
  }

  // Finished work keeps whatever it was planned with.
  for (const task of tasks.filter((t) => t.status !== 'closed' && t.status !== 'cancelled')) {
    const length = task.description.trim().length;
    if (length < MIN_TASK_DESCRIPTION) {
      problems.push(
        `${task.id}: the description is ${length} characters. Say what the user gets, then the details, the approach, and what's not in this task.`,
      );
    }
    if (task.subtasks.length < MIN_SUBTASKS) {
      problems.push(
        `${task.id}: has ${task.subtasks.length} subtasks; break it into at least ${MIN_SUBTASKS}.`,
      );
    }
    if (!task.size) problems.push(`${task.id}: give it a size (S, M or L).`);
    if (task.acceptanceCriteria.length < MIN_CRITERIA) {
      problems.push(
        `${task.id}: add acceptance criteria for the edge cases, not only the main path.`,
      );
    }
    for (const subtask of task.subtasks) {
      if (subtask.description.trim().length < MIN_SUBTASK_DESCRIPTION) {
        problems.push(
          `${subtask.id}: the description is too short. Say exactly what to build, where, and how you'd know it's done.`,
        );
      }
    }
  }

  // Bigger plans are delivered in stages the user can try.
  const planned = tasks.filter((t) => t.status === 'planned' || t.status === 'building');
  if (planned.length >= MILESTONE_THRESHOLD) {
    const placed = new Set(milestones.flatMap((m) => m.tasks));
    const loose = planned.filter((t) => !placed.has(t.id)).map((t) => t.id);
    if (milestones.length === 0) {
      problems.push('Group the tasks into milestones: stages the user can see and try.');
    } else if (loose.length > 0) {
      problems.push(`Put ${loose.join(', ')} in a milestone.`);
    }
  }

  return problems.length > MAX_REPORTED
    ? [
        ...problems.slice(0, MAX_REPORTED),
        `…and ${problems.length - MAX_REPORTED} more like these.`,
      ]
    : problems;
}

/** Required scope sections the scope doesn't have. */
export function missingSections(scope: string): string[] {
  const headings = new Set(
    [...scope.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => normalise(m[1] ?? '')),
  );
  return SCOPE_SECTIONS.filter((section) => !headings.has(normalise(section)));
}

/** Headings match regardless of case, spacing or curly apostrophes. */
function normalise(heading: string): string {
  return heading.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}
