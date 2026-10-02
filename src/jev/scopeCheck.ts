import type { Config } from '../core/config.js';
import type { Task } from '../core/schema.js';
import type { Store } from '../core/store.js';
import type { JevClient, NoulQuestion } from './client.js';
import { jevOn } from './features.js';
import { jevClient } from './providers.js';

/**
 * The scope check: when a builder hands work over, Jev reads its report and
 * judges, criterion by criterion, whether the evidence shows the work is done
 * rather than just saying so. Weak work goes back to the builder before the
 * user sees it, at most twice a round; what's still doubtful after that goes
 * to review marked as unproven, for the user to look at first.
 */

/** Below this, the evidence doesn't show the criterion is met: the work goes back. */
export const SEND_BACK_BELOW = 0.35;
/** Below this, it's handed over but marked as unproven. */
export const DOUBT_BELOW = 0.6;
/** Send-backs per round (since the user last asked for changes) before it goes to review anyway. */
export const MAX_SEND_BACKS = 2;

/** What the builder reported, as the submit tool received it. */
export interface ReportForCheck {
  summary: string;
  details?: string | undefined;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  checks: { name: string; passed: boolean }[];
}

/**
 * What to do with a handoff: send it back with a message for the builder, or
 * hand it over with the criteria (if any) the user should check first.
 */
export type ScopeVerdict = { sendBack: string } | { sendBack?: undefined; doubts: string[] };

export type ScopeCheck = (
  task: Task,
  report: ReportForCheck,
  files: string[],
) => Promise<ScopeVerdict>;

const DETAILS_LIMIT = 4_000;
const FILES_LIMIT = 60;

/** What Jev reads: the task and the builder's report, with the changed files' names. Never the code. */
export function scopeState(task: Task, report: ReportForCheck, files: string[]) {
  return {
    task: { title: task.title, description: task.description },
    report: {
      summary: report.summary,
      ...(report.details && { details: report.details.slice(0, DETAILS_LIMIT) }),
      criteria: report.criteria.map((c) => ({
        criterion: c.criterion,
        builderSaysMet: c.met,
        evidence: c.evidence,
      })),
      checks: report.checks,
      changedFiles:
        files.length > FILES_LIMIT
          ? [...files.slice(0, FILES_LIMIT), `…and ${files.length - FILES_LIMIT} more`]
          : files,
    },
  };
}

/** One yes/no per criterion the builder says is met, all asked at once. */
export function scopeQuestions(report: ReportForCheck): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  report.criteria.forEach((c, i) => {
    if (!c.met) return;
    questions[`criterion_${i + 1}`] = {
      type: 'noul',
      instructions:
        `Acceptance criterion ${i + 1}: "${c.criterion}". Does the builder's evidence show this ` +
        'criterion is actually met? Judge the evidence, not the claim.',
      criteria: {
        true: 'The evidence shows it working: a test, command or check that exercised it, and what that showed',
        false:
          'The evidence is missing, vague, only asserts it is done, or shows something other than this criterion',
      },
    };
  });
  return questions;
}

/** Ask Jev about each criterion. Undefined when it couldn't answer: nothing to go on. */
export async function judgeCriteria(
  jev: JevClient,
  task: Task,
  report: ReportForCheck,
  files: string[],
): Promise<{ criterion: string; evidence: string; shown: number }[] | undefined> {
  const questions = scopeQuestions(report);
  if (Object.keys(questions).length === 0) return [];
  const result = await jev.ask(scopeState(task, report, files), questions);
  if (!result.ok) return undefined;
  return report.criteria.flatMap((c, i) => {
    const answer = result.answers[`criterion_${i + 1}`];
    return answer ? [{ criterion: c.criterion, evidence: c.evidence, shown: answer.noul }] : [];
  });
}

/** The scope check for a project, when Jev is connected and it's switched on. */
export function scopeChecker(store: Store, config: Config): ScopeCheck {
  return async (task, report, files) => {
    const pass = { doubts: [] };
    if (!jevOn(await config.readSettings(), 'scopeCheck')) return pass;
    const link = await config.readJev();
    if (!link) return pass;
    const judged = await judgeCriteria(jevClient(link), task, report, files);
    if (!judged) return pass;

    const weak = judged.filter((j) => j.shown < SEND_BACK_BELOW);
    if (weak.length > 0 && (await sendBacksThisRound(store, task.id)) < MAX_SEND_BACKS) {
      await store.appendEvent({
        at: new Date().toISOString(),
        type: 'sent_back',
        taskId: task.id,
        message: `Sent back to the builder: the evidence didn’t show ${weak
          .map((w) => `“${w.criterion}”`)
          .join(', ')} ${weak.length === 1 ? 'was' : 'were'} met.`,
      });
      return {
        sendBack:
          'Not handed over yet: your evidence doesn’t show these acceptance criteria are met. ' +
          'Check each one for real (run the test or command that exercises it, or look at the ' +
          'screen), fix what isn’t working, then submit again with what the check showed:\n' +
          weak.map((w) => `- ${w.criterion} (your evidence: ${w.evidence})`).join('\n'),
      };
    }
    return { doubts: judged.filter((j) => j.shown < DOUBT_BELOW).map((j) => j.criterion) };
  };
}

/** Times the work was sent back since the user last asked for changes (or ever, if they haven't). */
async function sendBacksThisRound(store: Store, taskId: string): Promise<number> {
  let count = 0;
  for (const event of await store.readEvents()) {
    if (event.taskId !== taskId) continue;
    if (event.type === 'task_rejected') count = 0;
    if (event.type === 'sent_back') count++;
  }
  return count;
}
