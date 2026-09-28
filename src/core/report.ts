import { humanDuration, minutesSpent } from './estimates.js';
import { isComplete, milestoneProgress } from './milestones.js';
import { type Event, type Plan, SIZE_MINUTES } from './schema.js';
import { changeLogEntries } from './scope.js';

/**
 * The close-out report: what was built, what changed and was cut along the
 * way, how to run it, and what's next. Dazza writes the prose; these are the
 * facts it works from, gathered here so none are missed or invented.
 */

/** Sections every report has, in this order. */
export const REPORT_SECTIONS = [
  'What you have now',
  'What was built',
  'What changed along the way',
  'How to run it',
  'Known limits and follow-ups',
  'Suggested next steps',
] as const;

/** The message that asks the manager for a report, with the facts it needs. */
export function reportRequest(plan: Plan, events: Event[], scope: string | undefined): string {
  const complete = isComplete(plan);
  const lines = [
    complete
      ? 'Every task is closed. Write the close-out report for the user with `write_report`.'
      : 'The user asked for a progress report. Write it with `write_report`: what’s done so far, and what’s still to come in place of "Suggested next steps".',
    `Use these sections, in order: ${REPORT_SECTIONS.map((s) => `## ${s}`).join(', ')}.`,
    'Write for the user, not a developer: what they can do now, in plain words. Be specific, and only state what the facts below or the code show. Read the code if you need to (how to run it, say). Then tell the user in two lines that it’s ready and where to read it (the board, under Report).',
    '',
    '## Facts',
    ...milestoneProgress(plan).map(
      ({ milestone, closed, total }) =>
        `- ${milestone.id} ${milestone.title} (${closed}/${total} closed): ${milestone.goal}`,
    ),
    '',
    '### Tasks',
    ...plan.tasks.map((task) => {
      const spent = minutesSpent(events, task.id);
      const timing = [
        task.size && `sized ${task.size} (~${SIZE_MINUTES[task.size]} min)`,
        spent > 0 && `took ${humanDuration(spent).replace('about ', '~')}`,
      ].filter(Boolean);
      return [
        `- ${task.id} [${task.status}] ${task.title}${timing.length ? ` (${timing.join(', ')})` : ''}`,
        task.handoff && `  Handoff: ${task.handoff.summary}`,
        task.handoff?.howToVerify.length &&
          `  How to check it: ${task.handoff.howToVerify.join(' / ')}`,
        task.handoff?.checks.length &&
          `  Checks: ${task.handoff.checks.map((c) => `${c.name} ${c.passed ? 'passed' : 'FAILED'}`).join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n');
    }),
    '',
    '### Changes to the scope',
    ...(changeLogEntries(scope).length > 0 ? changeLogEntries(scope) : ['- None.']),
  ];
  return lines.join('\n');
}
