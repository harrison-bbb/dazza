import { boardLink } from '../board/link.js';
import { cancelTask, closeTask, prioritise, requestChanges } from '../core/actions.js';
import { milestoneProgress } from '../core/milestones.js';
import { answerPermission } from '../core/permissions.js';
import { findItem } from '../core/plan.js';
import type { Plan, Task } from '../core/schema.js';
import type { Store } from '../core/store.js';
import { redoTask } from '../core/work.js';
import { Git } from '../git/git.js';
import { stopTrying, tryTask } from '../preview/trying.js';
import { openInBrowser } from '../util/open.js';
import type { Command, CommandContext } from './commands.js';
import { NO_PLAN } from './describe.js';
import { paint } from './style.js';

/**
 * Commands for running the work directly: instant, and without a round trip
 * through the conversation. Everything here goes through the same actions as
 * the board and the chat, so the rules are the same.
 */

const ICON: Record<Task['status'], string> = {
  closed: paint.green('●'),
  // Waiting on the user stands out; the rest stays calm. No blues.
  review: paint.amber('◉'),
  building: paint.green('◐'),
  blocked: paint.red('⊘'),
  planned: '○',
  backlog: paint.dim('◌'),
  cancelled: paint.dim('⊖'),
};

export const WORK_COMMANDS: Command[] = [
  {
    name: 'tasks',
    description: 'Every task, by milestone, with its status and size',
    async run({ store, say }) {
      const plan = await store.readPlan();
      say(plan ? taskList(plan) : NO_PLAN);
    },
  },
  {
    name: 'review',
    aliases: ['inbox'],
    description: 'What’s waiting on you: work to review, questions, permission requests',
    async run({ store, say }) {
      say(await inbox(store));
    },
  },
  {
    name: 'accept',
    args: '<task>',
    description: 'Approve work in review; it merges into your branch',
    async run({ store, say }, args) {
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /accept T3');
      say(result(await closeTask(store, id)));
    },
  },
  {
    name: 'changes',
    args: '<task> <what to change>',
    description: 'Send work in review back, with what to change',
    async run({ store, say, building }, args) {
      const [first = '', ...rest] = args.trim().split(/\s+/);
      const id = taskArg(first);
      const note = rest.join(' ');
      if (!id || !note)
        return say(
          'Which task, and what should change? For example: /changes T3 make the button bigger',
        );
      say(requeued(await requestChanges(store, id, note), building()));
    },
  },
  {
    name: 'cancel',
    args: '<task>',
    description: 'Drop a task (asks you to confirm)',
    async run({ store, say, confirm }, args) {
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /cancel T5');
      const plan = await store.readPlan();
      const found = plan && findItem(plan, id);
      if (!plan || !found) return say(`No task ${id}.`);
      const dependents = plan.tasks.filter(
        (t) => t.dependsOn.includes(id) && t.status !== 'cancelled',
      );
      const warning = [
        found.task.status === 'building' && 'It’s being built right now.',
        found.task.handoff && 'Its finished work would be dropped.',
        dependents.length > 0 &&
          `${dependents.map((t) => t.id).join(', ')} depend${dependents.length === 1 ? 's' : ''} on it.`,
      ]
        .filter(Boolean)
        .join(' ');
      const title = found.subtask?.title ?? found.task.title;
      if (!(await confirm(`Cancel ${id} ${title}?${warning ? ` ${warning}` : ''}`)))
        return say('Kept it.');
      const outcome = await cancelTask(store, id);
      say(
        outcome.ok
          ? `${result(outcome)} ${paint.dim('If this changes the scope, tell me why and I’ll record it in the change log.')}`
          : result(outcome),
      );
    },
  },
  {
    name: 'redo',
    args: '<task> [what to do differently]',
    description: 'Throw away a task’s work and build it again from scratch (asks first)',
    async run({ store, say, confirm }, args) {
      const [first = '', ...rest] = args.trim().split(/\s+/);
      const id = taskArg(first);
      if (!id) return say('Which task? For example: /redo T3 use the existing Button component');
      const task = (await store.readPlan())?.tasks.find((t) => t.id === id);
      if (!task) return say(`No task ${id}.`);
      const note = rest.join(' ');
      if (!(await confirm(`Throw away all of ${id} ${task.title}’s work and start it again?`))) {
        return say('Kept it.');
      }
      say(result(await redoTask(store, new Git(store.root), id, note)));
    },
  },
  {
    name: 'next',
    args: '<task>',
    description: 'Build this task next (it still waits for what it depends on)',
    async run({ store, say }, args) {
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /next T7');
      say(result(await prioritise(store, id)));
    },
  },
  {
    name: 'diff',
    args: '<task>',
    description: 'What a task changed, file by file',
    async run({ store, say }, args) {
      const id = taskArg(args);
      const task = id ? (await store.readPlan())?.tasks.find((t) => t.id === id) : undefined;
      const build = id ? await store.readTaskBuild(id) : undefined;
      if (!task?.handoff?.commit || !build)
        return say(id ? `${id} hasn’t been handed over yet.` : 'Which task? For example: /diff T3');
      const stat = await new Git(store.root).diffStat(build.startCommit, task.handoff.commit);
      say(
        `${task.id} ${task.title}, on ${task.handoff.branch}:\n${stat}\n` +
          paint.dim(`Full diff: git diff ${build.startCommit.slice(0, 7)}..${task.handoff.branch}`),
      );
    },
  },
  {
    name: 'try',
    args: '<task>',
    description: 'Run a task’s work and open it, so you can try it before approving',
    async run({ store, say, status, confirm }, args) {
      if (args.trim() === 'stop') {
        const was = await stopTrying();
        return say(was ? `Stopped ${was}’s app.` : 'Nothing’s running.');
      }
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /try T3');
      let result = await tryTask(store, id, { status });
      if (!result.ok && result.needsInstall) {
        const { command, dir } = result.needsInstall;
        if (
          !(await confirm(
            `${id}’s dependencies aren’t installed yet. Install them now (${command}, usually a minute or two)?`,
          ))
        ) {
          return say(`OK. To do it yourself:\n  cd ${dir}\n  ${command}\nThen /try ${id} again.`);
        }
        result = await tryTask(store, id, { status, install: true });
      }
      if (!result.ok) return say(result.message);
      say(
        `${id} is running at ${result.url}${process.env.DAZZA_NO_BROWSER ? '' : ' (opened in your browser)'}.\n` +
          paint.dim(
            `It stops when you close Dazza, or with /try stop. Then /accept ${id} or /changes ${id} <what to change>.`,
          ),
      );
    },
  },
  {
    name: 'allow',
    args: '<task>',
    description: 'Let a task run the command it asked permission for',
    async run({ store, say, building }, args) {
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /allow T3');
      say(requeued(await answerPermission(store, id, true), building()));
    },
  },
  {
    name: 'deny',
    args: '<task>',
    description: 'Refuse the command a task asked permission for',
    async run({ store, say, building }, args) {
      const id = taskArg(args);
      if (!id) return say('Which task? For example: /deny T3');
      say(requeued(await answerPermission(store, id, false), building()));
    },
  },
  {
    name: 'stop',
    description: 'Stop building; the current task picks up where it left off next time',
    async run({ stopBuild }) {
      await stopBuild();
    },
  },
  {
    name: 'scope',
    description: 'Open the scope of work on the board',
    run({ boardUrl, say }: CommandContext) {
      const scope = boardLink(boardUrl, '#/doc');
      openInBrowser(scope);
      say(`Opened the scope: ${scope}`);
    },
  },
];

/** "t3" or "T3" → "T3"; also takes subtasks ("T3.2"). */
function taskArg(args: string): string | undefined {
  const id = args.trim().split(/\s+/)[0]?.toUpperCase();
  return id && /^T\d+(\.\d+)?$/.test(id) ? id : undefined;
}

function result(outcome: { ok: boolean; message: string }): string {
  return outcome.ok ? `${paint.green('✔')} ${outcome.message}` : outcome.message;
}

/** For work put back in the queue: what happens next. */
function requeued(outcome: { ok: boolean; message: string }, building: boolean): string {
  if (!outcome.ok) return outcome.message;
  return `${result(outcome)} ${paint.dim(building ? 'I’ll get on it now.' : 'Run /build when you want me to get on it.')}`;
}

/** Tasks grouped by milestone, each with its status, id, title and size. */
export function taskList(plan: Plan): string {
  const line = (t: Task) =>
    `  ${ICON[t.status]} ${paint.dim(t.id.padEnd(4))} ${t.status === 'cancelled' ? paint.dim(t.title) : t.title}${t.size ? paint.dim(` · ${t.size}`) : ''}${t.status === 'review' || t.status === 'blocked' ? paint.dim(`  ${t.status === 'review' ? 'in review' : 'blocked'}`) : ''}`;
  const placed = new Set(plan.milestones.flatMap((m) => m.tasks));
  const groups = milestoneProgress(plan).flatMap(({ milestone, closed, total, reached }) => [
    `${paint.bold(`${milestone.id} ${milestone.title}`)} ${paint.dim(reached ? '· reached' : `· ${closed}/${total}`)}`,
    ...plan.tasks.filter((t) => milestone.tasks.includes(t.id)).map(line),
  ]);
  const loose = plan.tasks.filter((t) => !placed.has(t.id));
  return [
    ...groups,
    ...(loose.length > 0
      ? [...(groups.length ? [paint.bold('Other')] : []), ...loose.map(line)]
      : []),
    paint.dim('● closed  ◉ in review  ◐ building  ⊘ blocked  ○ planned  ◌ backlog  ⊖ cancelled'),
  ].join('\n');
}

/** Everything waiting on the user, each with what to do about it. */
export async function inbox(store: Store): Promise<string> {
  const plan = await store.readPlan();
  if (!plan) return NO_PLAN;
  if (!plan.approvedAt)
    return 'The plan is waiting for your approval: look it over with /scope, then /approve.';
  const events = await store.readEvents();
  const permissions = await store.readPendingPermissions();
  const items: string[] = [];
  const blocked = plan.tasks.filter((t) => t.status === 'blocked' && !permissions[t.id]).length;

  for (const task of plan.tasks.filter((t) => t.status === 'review')) {
    const h = task.handoff;
    const unmet = h?.criteria.filter((c) => !c.met) ?? [];
    items.push(
      [
        `${ICON.review} ${paint.bold(`${task.id} ${task.title}`)} is ready for review`,
        h && `  ${h.summary}`,
        h?.criteria.length &&
          `  ${unmet.length ? paint.red(`${unmet.length} of ${h.criteria.length} criteria not met`) : `All ${h.criteria.length} criteria met`}${h.checks.length ? ` · checks: ${h.checks.map((c) => `${c.name} ${c.passed ? '✔' : '✗'}`).join(', ')}` : ''}`,
        h?.howToVerify.length && `  Check it: ${h.howToVerify.join(' → ')}`,
        paint.dim(
          `  /accept ${task.id} · /changes ${task.id} <what to change> · /diff ${task.id} · /try ${task.id}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  for (const task of plan.tasks.filter((t) => t.status === 'blocked')) {
    const permission = permissions[task.id];
    if (permission) {
      items.push(
        [
          `${ICON.blocked} ${paint.bold(`${task.id} ${task.title}`)} wants to run a command that needs your OK:`,
          `  ${paint.bold(permission.command)}`,
          `  Why: ${permission.why}`,
          paint.dim(`  /allow ${task.id} · /deny ${task.id}`),
        ].join('\n'),
      );
      continue;
    }
    const question = events
      .filter((e) => e.type === 'comment' && e.actor === 'dazza' && e.taskId === task.id)
      .at(-1)?.message;
    items.push(
      [
        `${ICON.blocked} ${paint.bold(`${task.id} ${task.title}`)} needs you`,
        question && `  ${question}`,
        paint.dim(
          blocked > 1
            ? `  Answer here, naming it (e.g. “${task.id}: …”), and I’ll pick it back up.`
            : '  Just answer here, and I’ll pick it back up.',
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return items.length > 0 ? items.join('\n\n') : 'Nothing’s waiting on you.';
}
