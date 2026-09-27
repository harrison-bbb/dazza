import { Check } from 'lucide-react';
import { useState } from 'react';
import { approvePlan, type Plan } from '../lib/api';
import { cn } from '../lib/format';
import { href, type View } from '../lib/router';
import { Logo } from './Logo';
import { NAV } from './Sidebar';
import { Button } from './ui';

interface HeaderProps {
  name: string;
  plan: Plan | null;
  view: View;
  live: boolean;
  onChange(): void;
}

export function Header({ name, plan, view, live, onChange }: HeaderProps) {
  const title = NAV.find((item) => item.view === view)?.label ?? '';

  return (
    <header className="shrink-0 border-b border-line bg-bg/80 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <Logo className="size-6 md:hidden" />
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="hidden truncate text-muted sm:inline">{name}</span>
          <span className="hidden text-line-strong sm:inline">/</span>
          <span className="font-semibold">{title}</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <LiveIndicator live={live} />
          {plan && <PlanBadge approved={Boolean(plan.approvedAt)} />}
          {plan && !plan.approvedAt && <ApproveButton onApproved={onChange} />}
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden" aria-label="Views">
        {NAV.map(({ view: target, label, icon: Icon }) => (
          <a
            key={target}
            href={href(target)}
            aria-current={view === target ? 'page' : undefined}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium',
              view === target ? 'bg-raised text-ink' : 'text-muted',
            )}
          >
            <Icon className="size-4" />
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function ApproveButton({
  onApproved,
  className,
}: {
  onApproved(): void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      disabled={busy}
      className={className}
      onClick={async () => {
        setBusy(true);
        await approvePlan();
        setBusy(false);
        onApproved();
      }}
    >
      <Check className="size-4" strokeWidth={3} />
      Approve plan
    </Button>
  );
}

function PlanBadge({ approved }: { approved: boolean }) {
  return (
    <span
      className={cn(
        'hidden h-7 items-center rounded-md border px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider sm:inline-flex',
        approved
          ? 'border-st-done/40 bg-st-done/10 text-accent-text'
          : 'border-st-review/40 bg-st-review/10 text-st-review',
      )}
    >
      {approved ? 'Approved' : 'Draft'}
    </span>
  );
}

function LiveIndicator({ live }: { live: boolean }) {
  return (
    <span
      className="hidden items-center gap-1.5 text-xs text-muted sm:flex"
      title={live ? 'Updates appear as Dazza works' : 'Reconnecting…'}
    >
      <span className="relative flex size-2">
        {live && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
        )}
        <span className={cn('relative size-2 rounded-full', live ? 'bg-accent' : 'bg-st-todo')} />
      </span>
      {live ? 'Live' : 'Offline'}
    </span>
  );
}
