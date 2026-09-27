import type { TaskStatus } from '../lib/api';
import { cn } from '../lib/format';
import { STATUS } from '../lib/status';

/** Status as icon + label, so it never relies on colour alone. */
export function StatusChip({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-raised px-2 text-xs font-medium text-ink-2',
        className,
      )}
    >
      <Icon className={cn('size-3.5', meta.text)} strokeWidth={2.5} aria-hidden />
      {meta.label}
    </span>
  );
}
