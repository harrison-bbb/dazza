import { Check, ChevronLeft, ChevronRight, CircleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Activity, type ComposerMode } from '../components/Activity';
import { LiveActivity } from '../components/LiveActivity';
import { Markdown } from '../components/Markdown';
import { Screenshots } from '../components/Screenshots';
import { StatusIcon, StatusLabel } from '../components/StatusIcon';
import { TaskEditor } from '../components/TaskEditor';
import { Button, Heading, Id, InlineText } from '../components/ui';
import {
  answerPermission,
  buildNext,
  cancelTask,
  closeTask,
  type Event,
  type Handoff,
  redoTask,
  type Subtask,
  setStatus,
  type Task,
} from '../lib/api';
import { cn, timeAgo } from '../lib/format';
import { paths } from '../lib/router';
import { blockerFor, milestones } from '../lib/timeline';

interface ItemViewProps {
  task: Task;
  /** Set when viewing a subtask of `task`. */
  subtask: Subtask | undefined;
  tasks: Task[];
  events: Event[];
  /** The stage this task is part of. */
  milestone?: { id: string; title: string } | undefined;
  /** A command this task is waiting on the user's OK to run. */
  permission?: { command: string; why: string } | undefined;
  onChange(): void;
}

/** A task or subtask: details on the left, the conversation about it on the right. */
/** Task sizes in the builder's time; see SIZE_MINUTES in src/core/schema.ts. */
const SIZE_LABEL = {
  S: 'Small · about 10 minutes',
  M: 'Medium · about 20 minutes',
  L: 'Large · about 40 minutes',
};

export function ItemView({
  task,
  subtask,
  tasks,
  events,
  permission,
  milestone,
  onChange,
}: ItemViewProps) {
  const [mode, setMode] = useState<ComposerMode>('comment');
  const [editing, setEditing] = useState(false);
  const item = subtask ?? task;
  const thread = events.filter((e) => e.taskId === item.id);
  const siblings = subtask ? task.subtasks : tasks;
  const blocker = subtask ? undefined : blockerFor(events, task);

  useKeyboardNavigation(
    siblings.map((s) => s.id),
    item.id,
    subtask ? paths.item(task.id) : paths.tasks,
  );

  return (
    // Side by side on wide screens, each column scrolling on its own;
    // stacked into one scrolling page on narrow ones.
    <div className="lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="lg:min-h-0 lg:overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-5 py-10">
          <div className="flex items-center gap-3 text-[13px]">
            <StatusLabel status={item.status} />
            <span className="text-faint">·</span>
            <Id>{item.id}</Id>
            <Pager ids={siblings.map((s) => s.id)} current={item.id} />
          </div>
          {editing && !subtask ? (
            <TaskEditor
              task={task}
              onDone={(saved) => {
                setEditing(false);
                if (saved) onChange();
              }}
            />
          ) : (
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">
              <InlineText>{item.title}</InlineText>
            </h1>
          )}

          {!subtask && !editing && (
            <TaskActions
              task={task}
              onRequestChanges={() => setMode('changes')}
              onEdit={() => setEditing(true)}
              onChange={onChange}
            />
          )}

          {!subtask && task.status === 'building' && (
            <section className="mt-6 rounded-lg border border-line px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                Building now
              </div>
              <LiveActivity taskId={task.id} live />
            </section>
          )}

          {!subtask && task.status === 'blocked' && permission ? (
            <PermissionNote taskId={task.id} permission={permission} onChange={onChange} />
          ) : (
            blocker && <BlockerNote question={blocker} onReply={() => setMode('unblock')} />
          )}

          {!editing && item.description && (
            // Descriptions are Markdown: the scope of a task, with details and boundaries.
            <div className="mt-6">
              <Markdown>{item.description}</Markdown>
            </div>
          )}

          {!subtask && task.handoff && <HandoffSection handoff={task.handoff} />}

          <dl className="mt-8 divide-y divide-line border-y border-line text-[13px]">
            {subtask ? (
              <Property label="Part of">
                <a
                  href={paths.item(task.id)}
                  className="flex min-w-0 items-center gap-1.5 hover:text-ink"
                >
                  <StatusIcon status={task.status} />
                  <Id>{task.id}</Id>
                  <span className="truncate text-ink-2">{task.title}</span>
                </a>
              </Property>
            ) : (
              <>
                <Property label="Depends on">
                  {task.dependsOn.length === 0 ? (
                    <span className="text-faint">Nothing</span>
                  ) : (
                    <span className="flex flex-col gap-1">
                      {task.dependsOn.map((id) => (
                        <DependencyLink key={id} task={tasks.find((t) => t.id === id)} id={id} />
                      ))}
                    </span>
                  )}
                </Property>
                {milestone && (
                  <Property label="Milestone">
                    <span className="flex items-center gap-1.5">
                      <Id>{milestone.id}</Id>
                      {milestone.title}
                    </span>
                  </Property>
                )}
                {task.size && <Property label="Size">{SIZE_LABEL[task.size]}</Property>}
                <Property label="Timeline">
                  <Timeline events={events} taskId={task.id} />
                </Property>
              </>
            )}
          </dl>

          {subtask ? (
            <section className="mt-10">
              <Heading aside={`${task.subtasks.length} in ${task.id}`}>Subtasks</Heading>
              <SubtaskList subtasks={task.subtasks} current={subtask.id} />
            </section>
          ) : (
            <>
              <section className="mt-10">
                <Heading>Done when</Heading>
                <ul className="space-y-2.5">
                  {task.acceptanceCriteria.map((criterion, i) => {
                    // The builder's own account of each criterion, from the handoff.
                    const report = task.handoff?.criteria[i];
                    return (
                      <li key={criterion} className="flex gap-3 leading-6">
                        <Checkbox checked={task.status === 'closed' || Boolean(report?.met)} />
                        <span className="min-w-0 text-ink-2">
                          <InlineText>{criterion}</InlineText>
                          {report && (
                            <span
                              className={cn(
                                'mt-0.5 block text-[12px] leading-5',
                                report.met ? 'text-muted' : 'text-red',
                              )}
                            >
                              {report.met ? '' : 'Not met: '}
                              <InlineText>{report.evidence}</InlineText>
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {task.subtasks.length > 0 && (
                <section className="mt-10">
                  <Heading
                    aside={`${task.subtasks.filter((s) => s.status === 'closed').length} of ${task.subtasks.filter((s) => s.status !== 'cancelled').length} closed`}
                  >
                    Subtasks
                  </Heading>
                  <SubtaskList subtasks={task.subtasks} />
                </section>
              )}
              {task.status !== 'building' && <BuildLog taskId={task.id} />}
            </>
          )}
        </div>
      </div>

      <Activity
        key={item.id}
        itemId={item.id}
        events={thread}
        mode={subtask ? 'comment' : mode}
        onModeChange={setMode}
        onChange={onChange}
      />
    </div>
  );
}

/** What the user can do with a task, depending on where it is. */
function TaskActions(props: {
  task: Task;
  onRequestChanges(): void;
  onEdit(): void;
  onChange(): void;
}) {
  const { task, onRequestChanges, onEdit, onChange } = props;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [redoNote, setRedoNote] = useState('');
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (task.status === 'closed' || task.status === 'cancelled') return null;

  const run = async (action: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    setProblem(result.ok ? undefined : result.message);
    onChange();
  };
  const editable = task.status !== 'building';
  // Work worth starting over: handed over, or blocked partway, or sent back.
  const restartable =
    task.status === 'review' ||
    task.status === 'blocked' ||
    (task.status === 'planned' && Boolean(task.handoff));

  if (redoing) {
    return (
      <div className="mt-5 rounded-lg border border-line px-4 py-3 text-[13px]">
        <p className="text-ink">
          Throw away all of {task.id}’s work and build it again from scratch?
        </p>
        <input
          value={redoNote}
          onChange={(e) => setRedoNote(e.target.value)}
          placeholder="What to do differently (optional)"
          className="mt-2 w-full rounded-md border border-line bg-transparent px-3 py-1.5 outline-none focus:border-line-strong"
        />
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await redoTask(task.id, redoNote);
                if (result.ok) setRedoing(false);
                return result;
              })
            }
          >
            Start over
          </Button>
          <Button variant="quiet" onClick={() => setRedoing(false)}>
            Keep the work
          </Button>
        </div>
        {problem && <p className="mt-2 text-red">{problem}</p>}
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      {task.status === 'review' && (
        <>
          <Button variant="primary" disabled={busy} onClick={() => run(() => closeTask(task.id))}>
            <Check className="size-3.5" strokeWidth={2.5} />
            Approve & close
          </Button>
          <Button disabled={busy} onClick={onRequestChanges}>
            Request changes
          </Button>
        </>
      )}
      {task.status === 'planned' && (
        <>
          <Button disabled={busy} onClick={() => run(() => buildNext(task.id))}>
            Build next
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => run(() => setStatus(task.id, 'backlog'))}
          >
            Move to backlog
          </Button>
        </>
      )}
      {task.status === 'backlog' && (
        <Button disabled={busy} onClick={() => run(() => setStatus(task.id, 'planned'))}>
          Move to planned
        </Button>
      )}
      {confirmCancel ? (
        <span className="flex items-center gap-1 text-[13px] text-muted">
          Cancel this task?
          <Button
            variant="quiet"
            className="text-red hover:text-red"
            disabled={busy}
            onClick={() => run(() => cancelTask(task.id))}
          >
            Yes, cancel
          </Button>
          <Button variant="quiet" onClick={() => setConfirmCancel(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button variant="quiet" onClick={() => setConfirmCancel(true)}>
          Cancel task
        </Button>
      )}
      {editable && (
        <Button variant="quiet" onClick={onEdit}>
          Edit
        </Button>
      )}
      {restartable && (
        <Button variant="quiet" onClick={() => setRedoing(true)}>
          Start over
        </Button>
      )}
      {problem && <p className="w-full text-[13px] text-red">{problem}</p>}
    </div>
  );
}

function BlockerNote({
  question,
  onReply,
}: {
  question: { message: string; images: string[] };
  onReply(): void;
}) {
  return (
    <div className="mt-6 rounded-lg border border-red/30 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-red">
        <CircleAlert className="size-3.5" />
        Dazza is waiting on you
      </div>
      <p className="mt-1.5 text-ink-2">
        <InlineText>{question.message}</InlineText>
      </p>
      <Screenshots paths={question.images} className="mt-3" />
      <Button className="mt-3" onClick={onReply}>
        Answer
      </Button>
    </div>
  );
}

/** The builder asking to run one command that Dazza's guard held back. */
function PermissionNote({
  taskId,
  permission,
  onChange,
}: {
  taskId: string;
  permission: { command: string; why: string };
  onChange(): void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      await answerPermission(taskId, allow);
    } finally {
      setBusy(false);
      onChange();
    }
  };
  return (
    <div className="mt-6 rounded-lg border border-red/30 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-red">
        <CircleAlert className="size-3.5" />
        Dazza needs your OK to run a command
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-hover px-3 py-2 font-mono text-[12px] text-ink">
        {permission.command}
      </pre>
      <p className="mt-2 text-[13px] leading-6 text-ink-2">
        <span className="text-muted">Why: </span>
        <InlineText>{permission.why}</InlineText>
      </p>
      <p className="mt-1 text-[12px] text-muted">Only this exact command, only for this task.</p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => answer(true)}>
          Allow once
        </Button>
        <Button disabled={busy} onClick={() => answer(false)}>
          Don’t allow
        </Button>
      </div>
    </div>
  );
}

/** What Dazza delivered: the summary, how to check it, the evidence, and the technical detail. */
function HandoffSection({ handoff }: { handoff: Handoff }) {
  return (
    <section className="mt-10">
      <Heading aside={`Submitted ${timeAgo(handoff.submittedAt)}`}>Handoff</Heading>
      <div className="rounded-lg border border-line">
        <p className="px-4 py-3 leading-7 text-ink-2">
          <InlineText>{handoff.summary}</InlineText>
        </p>

        {(handoff.branch || handoff.filesChanged !== undefined || handoff.checks.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line px-4 py-2.5 text-[12px] text-muted">
            {handoff.branch && <span className="font-mono text-ink-2">{handoff.branch}</span>}
            {handoff.filesChanged !== undefined && (
              <span>
                {handoff.filesChanged} {handoff.filesChanged === 1 ? 'file' : 'files'} changed
              </span>
            )}
            {handoff.checks.map((check) => (
              <span key={check.name} className="flex items-center gap-1">
                {check.passed ? (
                  <Check className="size-3.5 text-accent" strokeWidth={2.5} />
                ) : (
                  <X className="size-3.5 text-red" strokeWidth={2.5} />
                )}
                {check.name}
              </span>
            ))}
          </div>
        )}

        {handoff.howToVerify.length > 0 && (
          <div className="border-t border-line px-4 py-3">
            <div className="mb-1.5 text-[12px] text-muted">How to check it</div>
            {handoff.worktree && (
              // Until it's approved, the work only exists in its own checkout.
              <p className="mb-2 text-[13px] leading-6 text-ink-2">
                In its checkout: <InlineText>{`\`cd ${handoff.worktree}\``}</InlineText>
              </p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-6 text-ink-2 marker:text-faint">
              {handoff.howToVerify.map((step) => (
                <li key={step}>
                  <InlineText>{step}</InlineText>
                </li>
              ))}
            </ol>
          </div>
        )}

        {handoff.screenshots.length > 0 && (
          <Screenshots paths={handoff.screenshots} className="border-t border-line p-2" />
        )}

        {handoff.details && (
          // For a developer reviewing it; the summary above is the plain version.
          <details className="group border-t border-line px-4 py-3">
            <summary className="cursor-pointer text-[12px] text-muted hover:text-ink">
              Technical details
            </summary>
            <div className="mt-2 text-[13px] leading-6 text-ink-2">
              <Markdown>{handoff.details}</Markdown>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function Timeline({ events, taskId }: { events: Event[]; taskId: string }) {
  const steps = milestones(events, taskId);
  if (steps.length === 0) return <span className="text-faint">Not started</span>;
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {steps.map((step) => (
        <span key={`${step.label}-${step.at}`}>
          {step.label} <span className="text-faint">{timeAgo(step.at)}</span>
        </span>
      ))}
    </span>
  );
}

/** Previous / next buttons through the tasks (or a task's subtasks). */
function Pager({ ids, current }: { ids: string[]; current: string }) {
  const i = ids.indexOf(current);
  const prev = ids[i - 1];
  const next = ids[i + 1];
  const link = 'grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink';
  return (
    <span className="ml-auto flex items-center gap-0.5" title="k / j to move, Esc to go back">
      {prev ? (
        <a href={paths.item(prev)} className={link} aria-label={`Previous: ${prev}`}>
          <ChevronLeft className="size-4" />
        </a>
      ) : (
        <span className={cn(link, 'pointer-events-none opacity-30')}>
          <ChevronLeft className="size-4" />
        </span>
      )}
      {next ? (
        <a href={paths.item(next)} className={link} aria-label={`Next: ${next}`}>
          <ChevronRight className="size-4" />
        </a>
      ) : (
        <span className={cn(link, 'pointer-events-none opacity-30')}>
          <ChevronRight className="size-4" />
        </span>
      )}
    </span>
  );
}

/** j / k to step through items, Esc to go back up. Ignored while typing. */
function useKeyboardNavigation(ids: string[], current: string, backTo: string): void {
  const key = ids.join(',');
  useEffect(() => {
    const list = key.split(',');
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      const i = list.indexOf(current);
      const go = (id: string | undefined) => {
        if (id) window.location.hash = paths.item(id);
      };
      if (e.key === 'j') go(list[i + 1]);
      else if (e.key === 'k') go(list[i - 1]);
      else if (e.key === 'Escape') window.location.hash = backTo;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, current, backTo]);
}

function SubtaskList({ subtasks, current }: { subtasks: Subtask[]; current?: string }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {subtasks.map((s) => (
        <li key={s.id}>
          <a
            href={paths.item(s.id)}
            aria-current={s.id === current ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-3 px-1 py-2.5 hover:bg-hover/60',
              s.id === current && 'bg-hover/60',
            )}
          >
            <StatusIcon status={s.status} />
            <span className="w-9 shrink-0">
              <Id>{s.id}</Id>
            </span>
            <span className={cn('min-w-0 flex-1 truncate', s.status === 'closed' && 'text-muted')}>
              <InlineText>{s.title}</InlineText>
            </span>
            <ChevronRight className="size-4 text-faint group-hover:text-ink" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 py-2.5">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-2">{children}</dd>
    </div>
  );
}

function DependencyLink({ task, id }: { task: Task | undefined; id: string }) {
  return (
    <a href={paths.item(id)} className="flex min-w-0 items-center gap-1.5 hover:text-ink">
      {task && <StatusIcon status={task.status} />}
      <Id>{id}</Id>
      {task && <span className="truncate text-ink-2">{task.title}</span>}
    </a>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      role="img"
      aria-label={checked ? 'Met' : 'Not yet met'}
      className={cn(
        'mt-[5px] grid size-3.5 shrink-0 place-items-center rounded-[3px] border',
        checked ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong',
      )}
    >
      {checked && <Check className="size-2.5" strokeWidth={3.5} />}
    </span>
  );
}

/** How the task was built, step by step: collapsed, since it's for looking back. */
function BuildLog({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[13px] text-muted hover:text-ink"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Build log
      </button>
      {open && (
        <div className="mt-3">
          <LiveActivity taskId={taskId} live={false} limit={500} />
        </div>
      )}
    </section>
  );
}
