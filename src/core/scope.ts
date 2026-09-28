/**
 * The scope's change log: the last section of scope.md, kept by Dazza rather
 * than the model, so no revision can quietly drop the history. Each agreed
 * change gets an entry: a version, the date, what changed, why, and the tasks
 * it touched. The first plan is v1.
 */

export const CHANGE_LOG = 'Change log';

export interface ScopeChange {
  /** What changed, in a line: "Magic links instead of passwords". */
  summary: string;
  /** Why, as the user put it. */
  why: string;
  /** Tasks it added, changed or cancelled. */
  tasks: string[];
}

/**
 * The new scope, with the previous scope's change log carried over and this
 * change added on top. Any change log in `next` itself is replaced.
 */
export function withChangeLog(
  next: string,
  previous: string | undefined,
  change: ScopeChange,
  on: Date,
): string {
  const entries = changeLogEntries(previous);
  const version = entries.length + 2; // the first plan was v1
  const tasks = change.tasks.length > 0 ? ` (${change.tasks.join(', ')})` : '';
  const entry = `- **v${version} · ${day(on)}**: ${oneLine(change.summary)}${tasks}. Why: ${oneLine(change.why)}`;
  return `${withoutChangeLog(next).trimEnd()}\n\n## ${CHANGE_LOG}\n\n${[entry, ...entries].join('\n')}\n`;
}

/** Keep a scope's change log when the whole scope is rewritten without a change entry. */
export function keepChangeLog(next: string, previous: string | undefined): string {
  const entries = changeLogEntries(previous);
  const body = withoutChangeLog(next).trimEnd();
  return entries.length > 0
    ? `${body}\n\n## ${CHANGE_LOG}\n\n${entries.join('\n')}\n`
    : `${body}\n`;
}

/** The change log's heading line. Shared with the board, which has no copy of its own. */
const LOG_HEADING = new RegExp(`^## ${CHANGE_LOG}[ \\t]*$`, 'm');

/** The log's entries, newest first, as written. */
export function changeLogEntries(scope: string | undefined): string[] {
  return (splitChangeLog(scope ?? '').log ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

/** The scope without its change log: the part people edit. */
export function withoutChangeLog(scope: string): string {
  return scope.split(LOG_HEADING)[0] ?? scope;
}

/** The scope's editable body, and the change log Dazza keeps after it (heading included). */
export function splitChangeLog(markdown: string): { body: string; log: string | undefined } {
  const [body = '', log] = markdown.split(LOG_HEADING);
  return { body: body.trimEnd(), log: log === undefined ? undefined : `## ${CHANGE_LOG}${log}` };
}

/** The user's own date, e.g. "2026-09-28", not UTC's. */
function day(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}
