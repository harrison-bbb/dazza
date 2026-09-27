import { Fragment } from 'react';
import { cn } from '../lib/format';

export interface Crumb {
  label: string;
  href?: string;
}

/** Breadcrumb trail on the left, live status on the right. Always visible. */
export function TopBar({ crumbs, live }: { crumbs: Crumb[]; live: boolean }) {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg/90 px-5 backdrop-blur">
      <a href="#/" className="mr-1">
        <span className="sr-only">Dashboard</span>
        <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
          <rect width="32" height="32" rx="7" className="fill-accent" />
          <path d="M9 8h8a7 7 0 0 1 0 14h-8z" className="fill-bg" />
        </svg>
      </a>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.label}>
            {i > 0 && <span className="text-faint">/</span>}
            {crumb.href ? (
              <a href={crumb.href} className="truncate text-muted hover:text-ink">
                {crumb.label}
              </a>
            ) : (
              <span className="truncate text-ink">{crumb.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      <span
        className="ml-auto flex items-center gap-2 text-[12px] text-muted"
        title={live ? 'Updates appear as Dazza works' : 'Reconnecting to Dazza…'}
      >
        <span className={cn('size-1.5 rounded-full', live ? 'bg-accent' : 'bg-faint')} />
        {live ? 'Live' : 'Offline'}
      </span>
    </header>
  );
}
