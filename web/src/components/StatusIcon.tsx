import type { TaskStatus } from '../lib/api';
import { cn } from '../lib/format';
import { STATUS_LABEL } from '../lib/status';

/** Small circle glyphs, one per status. Colour only where it carries meaning. */
export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('size-3.5 shrink-0', COLOR[status], className)}
      role="img"
      aria-label={STATUS_LABEL[status]}
    >
      {GLYPH[status]}
    </svg>
  );
}

export function StatusLabel({ status }: { status: TaskStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-2">
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const COLOR: Record<TaskStatus, string> = {
  backlog: 'text-faint',
  planned: 'text-muted',
  building: 'text-accent',
  review: 'text-amber',
  blocked: 'text-red',
  cancelled: 'text-faint',
  closed: 'text-accent',
};

const ring = <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />;

const GLYPH: Record<TaskStatus, React.ReactNode> = {
  backlog: (
    <circle
      cx="7"
      cy="7"
      r="5.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeDasharray="2.2 2"
    />
  ),
  planned: ring,
  building: (
    <>
      {ring}
      <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
    </>
  ),
  review: (
    <>
      {ring}
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      {ring}
      <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="9.75" r="0.9" fill="currentColor" />
    </>
  ),
  cancelled: (
    <>
      {ring}
      <path d="m5 5 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  closed: (
    <>
      <circle cx="7" cy="7" r="6.25" fill="currentColor" />
      <path
        d="m4.5 7.2 1.7 1.7 3.4-3.6"
        fill="none"
        stroke="var(--color-bg)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};
