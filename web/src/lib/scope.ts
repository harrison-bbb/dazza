import { splitChangeLog } from '../../../src/core/scope.js';
import type { Plan, Task } from './api';
import { slugify } from './format';
import { STATUS_LABEL } from './status';

export interface ScopeSection {
  title: string;
  slug: string;
  body: string;
}

/** Split the scope document into its `## ` sections. */
export function scopeSections(markdown: string): ScopeSection[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [title = '', ...rest] = chunk.split('\n');
      return { title: title.trim(), slug: slugify(title), body: rest.join('\n').trim() };
    });
}

/** The first sentence of the Overview, as a one-line summary of the project. */
export function scopeSummary(markdown: string): string | undefined {
  const overview = scopeSections(markdown).find((s) => /^overview/i.test(s.title))?.body;
  return (
    overview
      ?.replace(/\s+/g, ' ')
      .match(/^.*?[.!?](\s|$)/)?.[0]
      .trim() ?? overview
  );
}

/**
 * The whole plan as one Markdown document, for exporting: the scope, then the
 * deliverables and their acceptance criteria (from the tasks), then the change log.
 */
export function planDocument(project: string, scope: string, plan: Plan | null): string {
  const { body, log } = splitChangeLog(scope);
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const table = (tasks: Task[]) => [
    '| Task | Acceptance criteria | Status |',
    '|---|---|---|',
    ...tasks.map(
      (t) =>
        `| ${t.id} ${cell(t.title)}${t.size ? ` (${t.size})` : ''} | ${t.acceptanceCriteria.map((c) => `• ${cell(c)}`).join('<br>')} | ${STATUS_LABEL[t.status]} |`,
    ),
  ];
  const deliverables = plan
    ? [
        '## Deliverables and acceptance criteria',
        '',
        ...(plan.milestones.length > 0
          ? plan.milestones.flatMap((m) => [
              `### ${m.id} ${m.title}`,
              '',
              m.goal,
              '',
              ...table(plan.tasks.filter((t) => m.tasks.includes(t.id))),
              '',
            ])
          : table(plan.tasks)),
      ]
    : [];
  return `${[`# ${project}: scope of work`, '', body, '', ...deliverables, '', log ?? '']
    .join('\n')
    .trim()}\n`;
}
