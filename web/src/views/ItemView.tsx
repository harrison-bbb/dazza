import { Check, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Activity, type ComposerMode } from '../components/Activity';
import { StatusIcon, StatusLabel } from '../components/StatusIcon';
import { Button, Heading, Id, InlineText } from '../components/ui';
import { cancelTask, closeTask, type Event, type Subtask, type Task } from '../lib/api';
import { cn } from '../lib/format';
import { paths } from '../lib/router';

interface ItemViewProps {
  task: Task;
  /** Set when viewing a subtask of `task`. */
  subtask: Subtask | undefined;
  tasks: Task[];
  events: Event[];
  onChange(): void;
}

/** A task or subtask: details on the left, the conversation about it on the right. */
export function ItemView({ task, subtask, tasks, events, onChange }: ItemViewProps) {
  const [mode, setMode] = useState<ComposerMode>('comment');
  const item = subtask ?? task;
  const thread = events.filter((e) => e.taskId === item.id);

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
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            <InlineText>{item.title}</InlineText>
          </h1>

          {!subtask && (
            <TaskActions
              task={task}
              onRequestChanges={() => setMode('changes')}
              onChange={onChange}
            />
          )}

          {item.description && (
            <p className="mt-6 leading-7 text-ink-2">
              <InlineText>{item.description}</InlineText>
            </p>
          )}

          <dl className="mt-8 divide-y divide-line border-y border-line text-[13px]">
            {subtask ? (
              <Property label="Part of">
                <a href={paths.item(task.id)} className="hover:text-ink">
                  <Id>{task.id}</Id> <span className="text-ink-2">{task.title}</span>
                </a>
              </Property>
            ) : (
              <>
                <Property label="Subtasks">
                  {task.subtasks.filter((s) => s.status === 'closed').length} of{' '}
                  {task.subtasks.length} closed
                </Property>
                <Property label="Depends on">
                  {task.dependsOn.length === 0 ? (
                    <span className="text-faint">Nothing</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-4 gap-y-1">
                      {task.dependsOn.map((id) => (
                        <DependencyLink key={id} task={tasks.find((t) => t.id === id)} id={id} />
                      ))}
                    </span>
                  )}
                </Property>
              </>
            )}
          </dl>

          {subtask && (
            <section className="mt-10">
              <Heading aside={`${task.id} · ${task.subtasks.length} subtasks`}>
                Subtasks in this task
              </Heading>
              <SubtaskList subtasks={task.subtasks} current={subtask.id} />
            </section>
          )}

          {!subtask && (
            <>
              <section className="mt-10">
                <Heading>Done when</Heading>
                <ul className="space-y-2.5">
                  {task.acceptanceCriteria.map((criterion) => (
                    <li key={criterion} className="flex gap-3 leading-6">
                      <Checkbox checked={task.status === 'closed'} />
                      <span className="text-ink-2">
                        <InlineText>{criterion}</InlineText>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {task.subtasks.length > 0 && (
                <section className="mt-10">
                  <Heading>Subtasks</Heading>
                  <SubtaskList subtasks={task.subtasks} />
                </section>
              )}
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
function TaskActions(props: { task: Task; onRequestChanges(): void; onChange(): void }) {
  const { task, onRequestChanges, onChange } = props;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const finished = task.status === 'closed' || task.status === 'cancelled';
  if (finished) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
    onChange();
  };

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
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
    </div>
  );
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
      <dd className="min-w-0 text-ink-2">{children}</dd>
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
