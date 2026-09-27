import type { Subtask, Task } from '../lib/api';
import { cn } from '../lib/format';
import { href } from '../lib/router';
import { STATUS } from '../lib/status';

/** One block per subtask, filled when done. */
export function SubtaskBlocks({
  subtasks,
  className,
}: {
  subtasks: Subtask[];
  className?: string;
}) {
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((s) => s.done).length;
  return (
    <div
      className={cn('flex items-center gap-2', className)}
      role="img"
      aria-label={`${done} of ${subtasks.length} subtasks done`}
    >
      <div className="flex gap-[3px]">
        {subtasks.map((subtask) => (
          <span
            key={subtask.id}
            className={cn('h-3 w-2 rounded-[2px]', subtask.done ? 'bg-st-done' : 'bg-line-strong')}
          />
        ))}
      </div>
      <span className="font-mono text-[11px] text-muted tabular-nums">
        {done}/{subtasks.length}
      </span>
    </div>
  );
}

/** The whole project as a strip of blocks, one per task, coloured by status. */
export function TaskStrip({ tasks }: { tasks: Task[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tasks.map((task) => (
        <a
          key={task.id}
          href={href('list', task.id)}
          title={`${task.id} · ${task.title} · ${STATUS[task.status].label}`}
          className={cn(
            'group relative h-9 min-w-9 flex-1 rounded-md transition hover:-translate-y-0.5',
            task.status === 'todo'
              ? 'bg-raised ring-1 ring-line-strong ring-inset'
              : STATUS[task.status].fill,
          )}
        >
          <span
            className={cn(
              'absolute inset-0 grid place-items-center font-mono text-[10px] font-semibold',
              task.status === 'todo' ? 'text-muted' : 'text-white/90',
            )}
          >
            {task.id}
          </span>
        </a>
      ))}
    </div>
  );
}
