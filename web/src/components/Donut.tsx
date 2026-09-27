import { useState } from 'react';
import type { Task, TaskStatus } from '../lib/api';
import { cn } from '../lib/format';
import { CHART_ORDER, laneOf, STATUS } from '../lib/status';

const SIZE = 176;
const THICKNESS = 18;
const RADIUS = (SIZE - THICKNESS) / 2;
const GAP = 2 / RADIUS; // 2px of arc between segments, in radians

/** Task status breakdown: a donut with the completion % in the middle and a labelled legend. */
export function StatusDonut({ tasks }: { tasks: Task[] }) {
  const [active, setActive] = useState<TaskStatus>();
  const counts = CHART_ORDER.map((status) => ({
    status,
    count: tasks.filter((task) => laneOf(task) === status).length,
  }));
  const total = tasks.length;
  const done = counts.find((c) => c.status === 'done')?.count ?? 0;
  const focus = active ? counts.find((c) => c.status === active) : undefined;

  const visible = counts.filter((c) => c.count > 0);
  const gap = visible.length > 1 ? GAP : 0;
  let angle = -Math.PI / 2;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="size-full"
          role="img"
          aria-label={`${done} of ${total} tasks done`}
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--raised)"
            strokeWidth={THICKNESS}
          />
          {visible.map(({ status, count }) => {
            const sweep = (count / total) * Math.PI * 2;
            const start = angle + gap / 2;
            const end = angle + sweep - gap / 2;
            angle += sweep;
            return (
              <path
                key={status}
                d={visible.length === 1 ? circlePath() : arcPath(start, end)}
                fill="none"
                stroke={STATUS[status].color}
                strokeWidth={THICKNESS}
                className={cn('transition-opacity', active && active !== status && 'opacity-25')}
              >
                <title>{`${STATUS[status].label}: ${count}`}</title>
              </path>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-4xl font-semibold tracking-tight">
              {focus ? focus.count : `${total ? Math.round((done / total) * 100) : 0}%`}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {focus ? STATUS[focus.status].label : 'complete'}
            </div>
          </div>
        </div>
      </div>

      <ul className="w-full min-w-0 space-y-1">
        {counts.map(({ status, count }) => {
          const meta = STATUS[status];
          const Icon = meta.icon;
          return (
            <li key={status}>
              <button
                type="button"
                disabled={count === 0}
                onMouseEnter={() => setActive(status)}
                onMouseLeave={() => setActive(undefined)}
                onFocus={() => setActive(status)}
                onBlur={() => setActive(undefined)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  active === status && 'bg-raised',
                  count === 0 && 'opacity-45',
                )}
              >
                <span className={cn('size-2.5 rounded-[3px]', meta.fill)} aria-hidden />
                <Icon className={cn('size-3.5', meta.text)} strokeWidth={2.5} aria-hidden />
                <span className="flex-1 text-ink-2">{meta.label}</span>
                <span className="font-mono text-xs tabular-nums text-ink">{count}</span>
                <span className="w-9 text-right font-mono text-xs tabular-nums text-muted">
                  {total ? Math.round((count / total) * 100) : 0}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function point(angle: number): string {
  return `${SIZE / 2 + RADIUS * Math.cos(angle)} ${SIZE / 2 + RADIUS * Math.sin(angle)}`;
}

function arcPath(start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(start)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${point(end)}`;
}

function circlePath(): string {
  const c = SIZE / 2;
  return `M ${c} ${c - RADIUS} a ${RADIUS} ${RADIUS} 0 1 1 0 ${RADIUS * 2} a ${RADIUS} ${RADIUS} 0 1 1 0 ${-RADIUS * 2}`;
}
