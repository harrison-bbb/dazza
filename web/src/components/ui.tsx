import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/format';

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'quiet' };

export function Button({ variant = 'secondary', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors',
        'disabled:pointer-events-none',
        variant === 'primary' &&
          'bg-accent text-accent-ink hover:bg-accent/90 disabled:bg-hover disabled:text-faint',
        variant !== 'primary' && 'disabled:opacity-40',
        variant === 'secondary' && 'border border-line-strong text-ink hover:bg-hover',
        variant === 'quiet' && 'px-1 text-muted hover:text-ink',
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
        className="rounded bg-hover px-1 py-px font-mono text-[0.9em] text-ink"
      >
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
  }
  parts.push(children.slice(last));
  return parts;
}

export function Id({ children }: { children: string }) {
  return <span className="font-mono text-[12px] text-muted">{children}</span>;
}

/** A quiet section heading. */
export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-[13px] font-medium text-muted">{children}</h2>
      {aside && <span className="text-[12px] text-faint">{aside}</span>}
    </div>
  );
}
