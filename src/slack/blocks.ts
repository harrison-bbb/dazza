import { boardLink } from '../board/link.js';
import { currentTask, progress } from '../core/plan.js';
import type { Plan, Task } from '../core/schema.js';
import type { Notification } from '../notify/notification.js';
import type { Block } from './api.js';

/**
 * Dazza's Slack messages, modals and Home tab, as Block Kit. Pure functions,
 * so what the user sees is easy to test.
 */

/** Action ids on Dazza's buttons. */
export const Actions = {
  approve: 'approve',
  requestChanges: 'request_changes',
  approvePlan: 'approve_plan',
  allowCommand: 'allow_command',
  refuseCommand: 'refuse_command',
  build: 'build',
  stop: 'stop',
  board: 'board',
} as const;

/** The block holding a notification's buttons, swapped for the outcome once used. */
export const DECISION_BLOCK = 'decision';
export const CHANGES_MODAL = 'request_changes';
export const NOTE_INPUT = 'note';

/** Slack caps a message's markdown at 12,000 characters. */
const MAX_MARKDOWN = 11_000;
const MAX_SECTION = 2_900;

export interface Rendered {
  /** The fallback: what push notifications and screen readers show. */
  text: string;
  blocks: Block[];
}

export interface Where {
  /** The project's name, so notifications from several projects can be told apart. */
  project: string;
  boardUrl: string;
}

export function notificationMessage(note: Notification, where: Where): Rendered {
  switch (note.kind) {
    case 'info':
      return { text: note.text, blocks: [markdown(note.text)] };
    case 'blocked':
      return {
        text: `${note.taskId} needs you: ${note.title}`,
        blocks: [
          section(`*Needs you · ${note.taskId}*\n${escapeText(note.title)}`),
          ...(note.question ? [markdown(note.question)] : []),
          context([
            where.project,
            note.images.length > 0 && screenshotsInThread(note.images.length),
            'Reply in this thread and I’ll pick it back up',
          ]),
        ],
      };
    case 'milestone':
      return {
        text: `${note.id} reached: ${note.title}`,
        blocks: [
          section(`*🏁 ${note.id} reached · ${escapeText(note.title)}*\n${escapeText(note.goal)}`),
          markdown(note.tasks.map((t) => `- ${t}`).join('\n')),
          context([
            where.project,
            note.branch && 'Merged into your project: /try in the terminal opens it',
            note.next && `Next up: ${note.next}`,
            note.images.length > 0 && screenshotsInThread(note.images.length),
          ]),
        ],
      };
    case 'permission':
      return {
        text: `${note.taskId} wants to run a command that needs your OK`,
        blocks: [
          section(`*Needs your OK · ${note.taskId}*\n${escapeText(note.title)}`),
          section(`\`\`\`${escapeText(note.command)}\`\`\`\n*Why:* ${escapeText(note.why)}`),
          context([where.project, 'Only this exact command, only for this task']),
          {
            type: 'actions',
            block_id: DECISION_BLOCK,
            elements: [
              { ...button('Allow once', Actions.allowCommand, note.taskId), style: 'primary' },
              { ...button('Don’t allow', Actions.refuseCommand, note.taskId), style: 'danger' },
            ],
          },
        ],
      };
    case 'review':
      return {
        text: `${note.taskId} is ready for review: ${note.title}`,
        blocks: [
          section(`*Ready for you to try · ${note.taskId}*\n${escapeText(note.title)}`),
          ...(note.summary ? [markdown(note.summary)] : []),
          ...(note.howToTry.length > 0
            ? [
                markdown(
                  `${note.runnable === false ? '**How to check it**' : `**How to try it** (on your computer: \`/try ${note.taskId}\`, or Try it on the board)`}\n${note.howToTry.map((step, i) => `${i + 1}. ${step}`).join('\n')}`,
                ),
              ]
            : []),
          context([
            where.project,
            ...note.facts,
            note.images.length > 0 && screenshotsInThread(note.images.length),
          ]),
          ...(note.progress ? [context([`⏱ ${note.progress}`])] : []),
          {
            type: 'actions',
            block_id: DECISION_BLOCK,
            elements: [
              {
                ...button('Approve', Actions.approve, note.taskId),
                style: 'primary',
                confirm: {
                  title: plain(`Approve ${note.taskId}?`),
                  text: plain('This closes the task and merges its branch into yours.'),
                  confirm: plain('Approve'),
                  deny: plain('Not yet'),
                },
              },
              button('Request changes', Actions.requestChanges, note.taskId),
              {
                ...button('Open on board (on your computer)', Actions.board, note.taskId),
                url: boardLink(where.boardUrl, `#/tasks/${note.taskId}`),
              },
            ],
          },
        ],
      };
  }
}

/** Swap a notification's buttons for what came of them, e.g. "Approved by you". */
export function resolved(blocks: Block[], outcome: string): Block[] {
  return blocks.map((block) => (block.block_id === DECISION_BLOCK ? context([outcome]) : block));
}

/** Dazza's answer, in as many messages as Slack's size limit needs. */
export function replyMessages(text: string): Rendered[] {
  return chunks(text, MAX_MARKDOWN).map((part) => ({ text: part, blocks: [markdown(part)] }));
}

/** Asks what to change when the user sends work back. */
export function changesModal(taskId: string, metadata: string): Block {
  return {
    type: 'modal',
    callback_id: CHANGES_MODAL,
    private_metadata: metadata,
    title: plain('Request changes'),
    submit: plain('Send back'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: NOTE_INPUT,
        label: plain(`What should change in ${taskId}?`),
        element: {
          type: 'plain_text_input',
          action_id: NOTE_INPUT,
          multiline: true,
          placeholder: plain('Be specific: the next build works from this note.'),
        },
      },
    ],
  };
}

/** The first message in the DM, once Slack is linked. */
export function welcomeMessage(): Rendered {
  const text = 'Dazza is connected.';
  return {
    text,
    blocks: [
      section(`*${text}* I’ll message you here when:`),
      markdown(
        [
          '- a task is **ready for your review**: approve it or send it back with the buttons',
          '- I’m **blocked** and need a decision or a credential: reply in the thread',
          '- a build stops, or you hit a usage limit',
        ].join('\n'),
      ),
      markdown(
        'Talk to me here like you would in the terminal: it’s the same conversation. ' +
          'The **Home** tab shows the project at a glance, and `/dazza status`, `/dazza build` ' +
          'and `/dazza stop` work from anywhere in Slack.',
      ),
    ],
  };
}

export interface HomeState extends Where {
  plan: Plan | undefined;
  building: boolean;
  /** False once Dazza closes: buttons would go nowhere, so none are shown. */
  online: boolean;
}

const STATUS_ICON: Record<Task['status'], string> = {
  backlog: '◌',
  planned: '○',
  building: '◐',
  review: '◉',
  blocked: '⊘',
  closed: '●',
  cancelled: '⊖',
};

/** The Home tab: where the project is at, what needs the user, and every task. */
export function homeView(state: HomeState): Block {
  const { plan } = state;
  const blocks: Block[] = [{ type: 'header', text: plain(`Dazza · ${state.project}`) }];

  if (!state.online) {
    blocks.push(
      section(
        '*Dazza isn’t running.* Start it with `dazza` in the project folder, ' +
          'and this page comes back to life.',
      ),
    );
  } else if (!plan) {
    blocks.push(
      section(
        'No plan yet. Tell me what we’re building in the *Messages* tab, or in the terminal.',
      ),
    );
  } else if (!plan.approvedAt) {
    blocks.push(section(`*Plan drafted: ${plan.tasks.length} tasks.* Waiting on your approval.`), {
      type: 'actions',
      elements: [
        { ...button('Approve plan', Actions.approvePlan), style: 'primary' },
        { ...button('Review on board (on your computer)', Actions.board), url: state.boardUrl },
      ],
    });
  } else {
    const { closed, total } = progress(plan);
    const current = currentTask(plan);
    blocks.push(
      section(
        [
          `*${closed} of ${total} tasks closed.*`,
          state.building
            ? current
              ? `Building ${current.id}: ${escapeText(current.title)}.`
              : 'Building.'
            : 'Not building right now.',
        ].join(' '),
      ),
      {
        type: 'actions',
        elements: [
          state.building
            ? button('Stop building', Actions.stop)
            : { ...button('Start building', Actions.build), style: 'primary' },
          { ...button('Open board (on your computer)', Actions.board), url: state.boardUrl },
        ],
      },
    );
  }

  if (plan && state.online) {
    const review = plan.tasks.filter((t) => t.status === 'review');
    const blocked = plan.tasks.filter((t) => t.status === 'blocked');
    if (review.length + blocked.length > 0) {
      blocks.push({ type: 'divider' }, section('*Needs you*'));
      for (const task of review) {
        blocks.push(
          section(`${STATUS_ICON.review}  *${task.id}* ${escapeText(task.title)}  ·  in review`),
          {
            type: 'actions',
            elements: [
              { ...button('Approve', Actions.approve, task.id), style: 'primary' },
              button('Request changes', Actions.requestChanges, task.id),
            ],
          },
        );
      }
      for (const task of blocked) {
        blocks.push(
          section(
            `${STATUS_ICON.blocked}  *${task.id}* ${escapeText(task.title)}  ·  blocked, waiting on your answer in *Messages*`,
          ),
        );
      }
    }
  }

  if (plan && plan.tasks.length > 0) {
    blocks.push({ type: 'divider' }, section('*All tasks*'));
    const lines = plan.tasks.map(
      (t) => `${STATUS_ICON[t.status]}  *${t.id}*  ${escapeText(t.title)}`,
    );
    for (const part of chunks(lines.join('\n'), MAX_SECTION)) blocks.push(section(part));
    blocks.push(
      context(['● closed  ◉ in review  ◐ building  ⊘ blocked  ○ planned  ◌ backlog  ⊖ cancelled']),
    );
  }

  // Slack allows 100 blocks on a Home tab.
  return { type: 'home', blocks: blocks.slice(0, 100) };
}

/** Slack's markup treats &, < and > specially; everything else is literal. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * What the user typed, as plain text: links and mentions unwrapped, entities
 * decoded. Slack sends "<https://x.dev|x.dev>" for a pasted link, for example.
 */
export function fromSlackText(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) =>
      url.endsWith(label) ? url : `${label} (${url})`,
    )
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function screenshotsInThread(count: number): string {
  return `📸 ${count} screenshot${count === 1 ? '' : 's'} in the thread`;
}

function section(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function markdown(text: string): Block {
  return { type: 'markdown', text };
}

function context(parts: (string | false | undefined)[]): Block {
  const text = parts.filter(Boolean).join('  ·  ');
  return { type: 'context', elements: [{ type: 'mrkdwn', text: text || ' ' }] };
}

function plain(text: string): { type: 'plain_text'; text: string } {
  return { type: 'plain_text', text };
}

function button(label: string, actionId: string, value?: string): Block {
  return { type: 'button', text: plain(label), action_id: actionId, ...(value && { value }) };
}

/** Split text into pieces no longer than `size`, at line breaks where possible. */
function chunks(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
