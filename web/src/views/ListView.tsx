import { ChevronDown, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { SubtaskBlocks } from '../components/Blocks';
import { StatusChip } from '../components/StatusChip';
import { TaskId } from '../components/ui';
import type { Task } from '../lib/api';
import { cn } from '../lib/format';
import { href } from '../lib/router';
import { LANES, laneOf, STATUS } from '../lib/status';

/** Tasks grouped by status, ClickUp list style. */
export function ListView({ tasks }: { tasks: Task[] }) {
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      {LANES.map(({ status }) => (
        <Group key={status} status={status} tasks={tasks.filter((t) => laneOf(t) === status)} />
      ))}
    </div>
  );
}

function Group({ status, tasks }: { status: Task['status']; tasks: Task[] }) {
  const [open, setOpen] = useState(true);
  const meta = STATUS[status];

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised/40"
      >
        <ChevronDown
          className={cn('size-4 text-muted transition-transform', !open && '-rotate-90')}
        />
        <span className={cn('h-5 w-1 rounded-full', meta.fill)} aria-hidden />
        <span className="text-sm font-semibold">{meta.label}</span>
        <span className="rounded-md bg-raised px-1.5 font-mono text-xs text-muted tabular-nums">
          {tasks.length}
        </span>
      </button>

      {open && tasks.length > 0 && (
        <div className="border-t border-line">
          <div className="hidden grid-cols-[4rem_1fr_9rem_6rem_8rem] gap-4 border-b border-line px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-muted md:grid">
            <span>ID</span>
            <span>Task</span>
            <span>Subtasks</span>
            <span>Criteria</span>
            <span>Depends on</span>
          </div>
          <ul className="divide-y divide-line">
            {tasks.map((task) => (
              <li key={task.id}>
                <a
                  href={href('list', task.id)}
                  className="grid grid-cols-[3rem_1fr] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-raised/50 md:grid-cols-[4rem_1fr_9rem_6rem_8rem]"
                >
                  <TaskId id={task.id} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{task.title}</span>
                      {task.status === 'rejected' && <StatusChip status="rejected" />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {task.description}
                    </span>
                  </span>
                  <SubtaskBlocks
                    subtasks={task.subtasks}
                    className="col-start-2 md:col-start-auto"
                  />
                  <span className="hidden items-center gap-1.5 text-xs text-muted md:flex">
                    <ListChecks className="size-3.5" />
                    {task.acceptanceCriteria.length}
                  </span>
                  <span className="hidden gap-1 md:flex">
                    {task.dependsOn.length === 0 ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      task.dependsOn.map((id) => (
                        <span key={id} className="rounded bg-raised px-1.5 py-0.5">
                          <TaskId id={id} className="text-[11px]" />
                        </span>
                      ))
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && tasks.length === 0 && (
        <p className="border-t border-line px-4 py-3 text-sm text-muted">No tasks.</p>
      )}
    </section>
  );
}
