import { ArrowUpRight, Check, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { addComment, type Event, type Task } from '../lib/api';
import { cn } from '../lib/format';
import { href, navigate } from '../lib/router';
import { ActivityFeed } from './ActivityFeed';
import { SubtaskBlocks } from './Blocks';
import { StatusChip } from './StatusChip';
import { Button, InlineText, Label, TaskId } from './ui';

interface TaskDrawerProps {
  task: Task;
  tasks: Task[];
  events: Event[];
  onChange(): void;
}

const close = () => navigate({ taskId: undefined });

export function TaskDrawer({ task, tasks, events, onChange }: TaskDrawerProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dependencies = task.dependsOn
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined);
  const activity = events.filter((e) => e.taskId === task.id);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close task"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
        className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-panel shadow-2xl outline-none"
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
          <TaskId id={task.id} className="text-sm" />
          <StatusChip status={task.status} />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="ml-auto grid size-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-8 p-6">
            <div>
              <h1 id="task-title" className="text-xl font-semibold tracking-tight">
                {task.title}
              </h1>
              <p className="mt-3 leading-7 text-ink-2">
                <InlineText>{task.description}</InlineText>
              </p>
            </div>

            <section>
              <Label className="mb-3">Acceptance criteria</Label>
              <ul className="space-y-2">
                {task.acceptanceCriteria.map((criterion) => (
                  <Checkline key={criterion} checked={task.status === 'done'}>
                    {criterion}
                  </Checkline>
                ))}
              </ul>
            </section>

            {task.subtasks.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <Label>Subtasks</Label>
                  <SubtaskBlocks subtasks={task.subtasks} />
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {task.subtasks.map((subtask) => (
                    <li
                      key={subtask.id}
                      className="flex items-center gap-3 bg-raised/40 px-3 py-2.5"
                    >
                      <Checkbox checked={subtask.done} />
                      <TaskId id={subtask.id} />
                      <span
                        className={cn(
                          'text-sm',
                          subtask.done ? 'text-muted line-through' : 'text-ink-2',
                        )}
                      >
                        <InlineText>{subtask.title}</InlineText>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {dependencies.length > 0 && (
              <section>
                <Label className="mb-3">Depends on</Label>
                <div className="flex flex-wrap gap-2">
                  {dependencies.map((dep) => (
                    <a
                      key={dep.id}
                      href={href('list', dep.id)}
                      className="group inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1.5 text-sm hover:border-line-strong"
                    >
                      <TaskId id={dep.id} />
                      <span className="text-ink-2 group-hover:text-ink">{dep.title}</span>
                      <ArrowUpRight className="size-3.5 text-muted" />
                    </a>
                  ))}
                </div>
              </section>
            )}

            <section>
              <Label className="mb-4">Activity</Label>
              <div className="-mx-5">
                <ActivityFeed events={activity} />
              </div>
            </section>
          </div>
        </div>

        <CommentBox taskId={task.id} onSent={onChange} />
      </aside>
    </div>
  );
}

function CommentBox({ taskId, onSent }: { taskId: string; onSent(): void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    const result = await addComment(taskId, body);
    setBusy(false);
    if (result.ok) {
      setBody('');
      onSent();
    }
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-line p-4">
      <div className="rounded-xl border border-line bg-raised focus-within:border-line-strong">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          rows={2}
          placeholder="Leave a note for Dazza…"
          aria-label="Note for Dazza"
          className="block w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between px-3 pb-2.5">
          <span className="text-xs text-muted">
            Dazza reads these next time you chat. ⌘↵ to send
          </span>
          <Button type="submit" variant="primary" disabled={!body.trim() || busy} className="h-8">
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}

function Checkline({ checked, children }: { checked: boolean; children: string }) {
  return (
    <li className="flex gap-3 rounded-lg border border-line bg-raised/40 px-3 py-2.5">
      <Checkbox checked={checked} className="mt-0.5" />
      <span className={cn('text-sm leading-6', checked ? 'text-muted' : 'text-ink-2')}>
        <InlineText>{children}</InlineText>
      </span>
    </li>
  );
}

function Checkbox({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={checked ? 'Done' : 'Not done'}
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-[5px] border-2',
        checked ? 'border-st-done bg-st-done text-white' : 'border-line-strong',
        className,
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3.5} />}
    </span>
  );
}
