import { milestoneTimes } from './estimates.js';
import { type Milestone, type Plan, SCHEMA_VERSION, type Task } from './schema.js';

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
  'Design direction',
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
/**
 * The first milestone is when the user first gets to try something: a long
 * wait there is what makes a build feel slow.
 */
const FIRST_MILESTONE_MINUTES = 60;
/** Enough to act on without burying the manager in a wall of errors. */
const MAX_REPORTED = 12;

/** What's missing from a plan, as instructions to fix it. Empty when it passes. */
export function reviewPlan(scope: string, tasks: Task[], milestones: Milestone[] = []): string[] {
  const problems: string[] = [];

  const missing = missingSections(scope);
  if (missing.length > 0) {
    problems.push(`The scope is missing sections: ${missing.map((s) => `## ${s}`).join(', ')}.`);
  }
  const design = thinDesign(scope);
  if (design) problems.push(design);

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

/**
 * A design direction too thin to build from: builders fall back on generic
 * defaults, which is how apps end up looking generated. One for work with no
 * screen can be a line saying so.
 */
function thinDesign(scope: string): string | undefined {
  const body = sectionBody(scope, 'Design direction');
  if (body === undefined) return undefined; // reported as missing
  if (/\bno (visual |user |graphical )?(interface|ui|screens?)\b/i.test(body)) return undefined;
  const colours = body.match(/#[0-9a-f]{3,8}\b/gi)?.length ?? 0;
  if (body.length >= MIN_DESIGN_DIRECTION && colours >= MIN_DESIGN_COLOURS) return undefined;
  return (
    'The design direction is too thin to build from: give the feel (and a product it’s like), colour tokens with hex values, ' +
    'the type scale, spacing and radius, how components look, the layout, and what to avoid. For work with no screen, say so in a line.'
  );
}

/** Enough for the feel, the tokens, type, space, components, layout and what to avoid. */
const MIN_DESIGN_DIRECTION = 400;
/** Background, surface, text, muted, accent at least. */
const MIN_DESIGN_COLOURS = 4;

/** The text under a `## heading`, up to the next one; undefined if there's no such section. */
function sectionBody(scope: string, heading: string): string | undefined {
  const lines = scope.split('\n');
  const start = lines.findIndex(
    (line) => /^##\s+/.test(line) && normalise(line.replace(/^##\s+/, '')) === normalise(heading),
  );
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^##\s+/.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
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

/**
 * Advice, not a rule: if a new plan's first stage takes more than an hour to
 * build, say so, so the manager can offer a smaller one. The user may want it
 * big, so it never stops the plan being approved.
 */
export function firstMilestoneAdvice(plan: Plan, parallel: number): string | undefined {
  const [first, second] = plan.milestones;
  // One stage is the whole plan; and once work's been built, they've seen something.
  if (!first || !second) return undefined;
  if (plan.tasks.some((t) => ['building', 'blocked', 'review', 'closed'].includes(t.status))) {
    return undefined;
  }
  const minutes = milestoneTimes(plan, [], { parallel })[0]?.minutes ?? 0;
  if (minutes <= FIRST_MILESTONE_MINUTES) return undefined;
  return (
    `${first.id} takes about ${Math.round(minutes)} minutes to build before the user can try anything. ` +
    'Unless they asked for it this way, offer a smaller first stage (an hour or less): move tasks into later milestones, or split one.'
  );
}
