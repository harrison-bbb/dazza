import { ChevronDown, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { StatusIcon } from '../components/StatusIcon';
import { Id, InlineText } from '../components/ui';
import type { Event, Plan, Task, TaskStatus } from '../lib/api';
import { cn, timeAgo } from '../lib/format';
import { paths } from '../lib/router';
import { STATUS_LABEL, STATUS_ORDER } from '../lib/status';
import { nextUp, statusSince } from '../lib/timeline';

/** Every task, grouped by status. Finished groups start collapsed. */
export function TaskList({ plan, events }: { plan: Plan; events: Event[] }) {
  const next = nextUp(plan)?.id;
  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10">
      <div className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <span className="text-[13px] text-muted">{plan.tasks.length} total</span>
      </div>
      <div className="space-y-6">
        {STATUS_ORDER.map((status) => {
          const group = plan.tasks.filter((t) => t.status === status);
          return group.length > 0 ? (
            <Group key={status} status={status} tasks={group} events={events} next={next} />
          ) : null;
        })}
      </div>
    </div>
  );
}

interface GroupProps {
  status: TaskStatus;
  tasks: Task[];
  events: Event[];
  next: string | undefined;
}

function Group({ status, tasks, events, next }: GroupProps) {
  const [open, setOpen] = useState(status !== 'closed' && status !== 'cancelled');
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mb-1 flex items-center gap-2 py-1 text-[13px] text-muted hover:text-ink"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
        <StatusIcon status={status} />
        <span className="font-medium text-ink">{STATUS_LABEL[status]}</span>
        <span className="text-faint">{tasks.length}</span>
      </button>
      {open && (
        <ul className="divide-y divide-line border-y border-line">
          {tasks.map((task) => (
            <li key={task.id}>
              <Row
                task={task}
                context={context(task, events, next)}
                comments={countComments(events, task)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ task, context, comments }: { task: Task; context: string; comments: number }) {
  const closed = task.subtasks.filter((s) => s.status === 'closed').length;
  return (
    <a
      href={paths.item(task.id)}
      className="flex items-center gap-3 px-2 py-2.5 transition-colors hover:bg-hover/60"
    >
      <StatusIcon status={task.status} />
      <span className="w-8 shrink-0">
        <Id>{task.id}</Id>
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          task.status === 'cancelled' && 'text-muted line-through',
        )}
      >
        <InlineText>{task.title}</InlineText>
      </span>
      <span
        className={cn(
          'hidden shrink-0 text-[12px] sm:block',
          context === 'Next' ? 'text-accent' : 'text-muted',
        )}
      >
        {context}
      </span>
      <span className="flex w-8 shrink-0 items-center justify-end gap-1 text-[12px] text-muted">
        {comments > 0 && (
          <>
            <MessageSquare className="size-3.5" />
            {comments}
          </>
        )}
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-[12px] text-muted tabular-nums">
        {task.subtasks.length > 0 && `${closed}/${task.subtasks.length}`}
      </span>
    </a>
  );
}

/** A few words on where the task stands, beyond its status. */
function context(task: Task, events: Event[], next: string | undefined): string {
  const since = statusSince(events, task);
  const ago = since ? timeAgo(since) : '';
  switch (task.status) {
    case 'building':
      return ago && `Started ${ago}`;
    case 'review':
      return ago && `Ready ${ago}`;
    case 'blocked':
      return 'Waiting on you';
    case 'planned':
      if (task.id === next) return 'Next';
      return task.dependsOn.length > 0 ? `After ${task.dependsOn.join(', ')}` : '';
    case 'closed':
      return ago && `Closed ${ago}`;
    default:
      return '';
  }
}

function countComments(events: Event[], task: Task): number {
  const ids = new Set([task.id, ...task.subtasks.map((s) => s.id)]);
  return events.filter((e) => e.type === 'comment' && e.taskId && ids.has(e.taskId)).length;
}
