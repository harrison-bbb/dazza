import type { BuildEvent } from '../core/builder.js';
import { clock } from '../core/errors.js';
import type { Store } from '../core/store.js';

/**
 * Something the user should hear about while they're away. Each channel words
 * it its own way: plain text on Telegram, blocks with buttons on Slack.
 */
export type Notification =
  | {
      kind: 'review';
      taskId: string;
      title: string;
      summary?: string;
      /** Short facts about the work, e.g. "5 files changed". */
      facts: string[];
      /** Screenshot files to send with it. */
      images: string[];
    }
  | { kind: 'blocked'; taskId: string; title: string; question?: string; images: string[] }
  /** The builder wants to run a command that needs the user's OK. */
  | {
      kind: 'permission';
      taskId: string;
      title: string;
      command: string;
      why: string;
      images: string[];
    }
  | { kind: 'info'; text: string; taskId?: string; images: string[] };

/** A plain message, e.g. a build that stopped, or screenshots Dazza shared. */
export function info(text: string, images: string[] = [], taskId?: string): Notification {
  return { kind: 'info', text, images, ...(taskId && { taskId }) };
}

/** What to tell the user about a build event, if anything. */
export async function notificationFor(
  event: BuildEvent,
  store: Store,
): Promise<Notification | undefined> {
  if (event.type === 'stopped') return info(event.reason);
  if (event.type === 'waiting' && event.reason === 'usage_limit') {
    return info(
      `⏸ You’ve hit your usage limit, so I’ve paused ${event.task.id}. ` +
        `I’ll pick it back up at ${clock(event.until)}, as long as Dazza stays open on your computer.`,
      [],
      event.task.id,
    );
  }
  if (event.type !== 'task_finished' || event.outcome === 'paused') return undefined;

  const plan = await store.readPlan();
  const task = plan?.tasks.find((t) => t.id === event.task.id) ?? event.task;

  if (event.outcome === 'blocked') {
    const { pending } = await store.readPermissions(task.id);
    if (pending) {
      return { kind: 'permission', taskId: task.id, title: task.title, ...pending, images: [] };
    }
    const question = (await store.readEvents())
      .filter((e) => e.type === 'comment' && e.actor === 'dazza' && e.taskId === task.id)
      .at(-1);
    return {
      kind: 'blocked',
      taskId: task.id,
      title: task.title,
      ...(question && { question: question.message }),
      images: (question?.images ?? []).map((path) => store.mediaFile(path)),
    };
  }

  const handoff = task.handoff;
  const checks = handoff?.checks ?? [];
  const failing = checks.filter((c) => !c.passed).length;
  const facts = [
    handoff?.filesChanged !== undefined && plural(handoff.filesChanged, 'file', 'changed'),
    checks.length > 0 &&
      (failing ? `${plural(failing, 'failing check')}` : plural(checks.length, 'check', 'passed')),
  ].filter((fact): fact is string => typeof fact === 'string');
  return {
    kind: 'review',
    taskId: task.id,
    title: task.title,
    ...(handoff?.summary && { summary: handoff.summary }),
    facts,
    images: (handoff?.screenshots ?? []).map((path) => store.mediaFile(path)),
  };
}

function plural(count: number, noun: string, suffix = ''): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}${suffix && ` ${suffix}`}`;
}
