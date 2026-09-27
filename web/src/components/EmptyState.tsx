import { Logo } from './Logo';

export function EmptyState() {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md text-center">
        <Logo className="mx-auto size-12" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">No plan yet</h1>
        <p className="mt-2 leading-7 text-muted">
          Tell Dazza what you're building in your terminal. Once the scope is agreed, the plan shows
          up here for you to review and approve.
        </p>
        <div className="mt-6 rounded-xl border border-line bg-panel p-4 text-left font-mono text-sm">
          <span className="text-accent-text">›</span>{' '}
          <span className="text-ink-2">I want to build a habit tracker…</span>
          <span className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-accent" />
        </div>
      </div>
    </div>
  );
}
