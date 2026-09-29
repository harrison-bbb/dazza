import type { Plan, Task } from '../src/core/schema.js';

export function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: `Task ${overrides.id}`,
    description: 'Do the thing.',
    acceptanceCriteria: ['The thing is done'],
    subtasks: [],
    dependsOn: [],
    status: 'planned',
    ...overrides,
  };
}

export function makePlan(tasks: Task[]): Plan {
  return { version: 1, approvedAt: null, tasks, milestones: [], problems: [] };
}

/** A scope with every section the manager is asked for. */
/** A design direction a builder could follow without guessing. */
export const DESIGN = [
  '- **Feel:** calm and quick, like Things: a list you check a few times a day.',
  '- **Colour:** background #fafaf9, surface #ffffff, border #e7e5e4, text #1c1917, muted #78716c, accent #16a34a; danger #dc2626. Light only.',
  '- **Type:** system font stack; 13/15/18/24; regular and semibold.',
  '- **Space and shape:** 4px grid, 8px radius, borders not shadows.',
  '- **Components:** quiet buttons, one primary per screen; inline edit; an empty state with one action.',
  '- **Layout:** one column, 640px wide, full width on phones.',
  '- **Avoid:** gradients, emoji, cards inside cards.',
].join('\n');

export const SCOPE = [
  '# Todo app',
  ...[
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
  ].map((section) => `\n## ${section}\n${section === 'Design direction' ? DESIGN : 'Details.'}`),
].join('\n');

/** A task written to the standard save_plan asks for. */
export function plannedTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  const detail = (what: string) =>
    `${what} ${'Specific behaviour, where it lives, and how you know it is done. '.repeat(2)}`;
  return makeTask({
    description: detail('What the user gets.').repeat(4),
    acceptanceCriteria: ['The main path works', 'The empty state shows a message'],
    size: 'M',
    subtasks: [1, 2].map((n) => ({
      id: `${overrides.id}.${n}`,
      title: `Part ${n}`,
      description: detail(`Build part ${n}.`),
      status: 'planned' as const,
    })),
    ...overrides,
  });
}

/** A worker's handoff for a task made with makeTask (one criterion). */
export const workReport = {
  summary: 'Done',
  howToVerify: ['Look at it'],
  criteria: [{ criterion: 'The thing is done', met: true, evidence: 'Checked it by hand' }],
  checks: [],
};
