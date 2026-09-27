import { Link2, ListChecks } from 'lucide-react';
import { SubtaskBlocks } from '../components/Blocks';
import { StatusChip } from '../components/StatusChip';
import { TaskId } from '../components/ui';
import type { Task } from '../lib/api';
import { cn } from '../lib/format';
import { href } from '../lib/router';
import { LANES, laneOf, STATUS } from '../lib/status';

/** Kanban columns by status. */
export function BoardView({ tasks }: { tasks: Task[] }) {
  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4 sm:p-6">
      {LANES.map(({ status }) => {
        const meta = STATUS[status];
        const Icon = meta.icon;
        const lane = tasks.filter((t) => laneOf(t) === status);
        return (
          <section key={status} className="flex min-w-64 flex-1 flex-col">
            <header className="mb-3 flex items-center gap-2 px-1">
              <span className={cn('grid size-6 place-items-center rounded-md', meta.fill)}>
                <Icon className="size-3.5 text-white" strokeWidth={2.75} />
              </span>
              <h2 className="text-sm font-semibold">{meta.label}</h2>
              <span className="font-mono text-xs text-muted tabular-nums">{lane.length}</span>
            </header>
            <div className="flex flex-1 flex-col gap-2.5 rounded-xl border border-line bg-panel/50 p-2.5">
              {lane.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
              {lane.length === 0 && (
                <div className="grid h-20 place-items-center rounded-lg border border-dashed border-line text-xs text-muted">
                  Empty
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  return (
    <a
      href={href('board', task.id)}
      className="group block rounded-lg border border-line bg-panel p-3.5 shadow-[0_1px_0_rgb(0_0_0/0.04)] transition hover:-translate-y-0.5 hover:border-line-strong"
    >
      <div className="flex items-center justify-between gap-2">
        <TaskId id={task.id} />
        {task.status === 'rejected' && <StatusChip status="rejected" />}
      </div>
      <h3 className="mt-1.5 text-sm leading-5 font-semibold">{task.title}</h3>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{task.description}</p>
      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
        <SubtaskBlocks subtasks={task.subtasks} />
        <span
          className="ml-auto flex items-center gap-1 text-[11px] text-muted"
          title="Acceptance criteria"
        >
          <ListChecks className="size-3.5" />
          {task.acceptanceCriteria.length}
        </span>
        {task.dependsOn.length > 0 && (
          <span
            className="flex items-center gap-1 text-[11px] text-muted"
            title={`Depends on ${task.dependsOn.join(', ')}`}
          >
            <Link2 className="size-3.5" />
            {task.dependsOn.length}
          </span>
        )}
      </div>
    </a>
  );
}
