import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/format';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-xl border border-line bg-panel', className)} {...props} />;
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
      <Label>{title}</Label>
      {action}
    </header>
  );
}

/** Small uppercase mono label used for section headings. */
export function Label({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn(
        'font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted',
        className,
      )}
      {...props}
    />
  );
}

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'ghost' };

export function Button({ variant = 'ghost', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-semibold transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary'
          ? 'bg-accent text-accent-ink shadow-[inset_0_-2px_0_rgb(0_0_0/0.18)] hover:brightness-110 active:translate-y-px'
          : 'border border-line bg-panel text-ink-2 hover:border-line-strong hover:text-ink',
        className,
      )}
      {...props}
    />
  );
}

/** Plain text with `inline code` rendered, for agent-written titles and criteria. */
export function InlineText({ children }: { children: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of children.matchAll(/`([^`]+)`/g)) {
    parts.push(children.slice(last, match.index));
    parts.push(
      <code
        key={match.index}
        className="rounded border border-line bg-raised px-1 font-mono text-[0.85em] text-ink"
      >
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
  }
  parts.push(children.slice(last));
  return parts;
}

/** A task id in mono, the way it's referenced everywhere. */
export function TaskId({ id, className }: { id: string; className?: string }) {
  return <span className={cn('font-mono text-xs text-muted tabular-nums', className)}>{id}</span>;
}
