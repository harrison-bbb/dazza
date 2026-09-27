import {
  Columns3,
  FileText,
  LayoutDashboard,
  ListTodo,
  type LucideIcon,
  Moon,
  Sun,
} from 'lucide-react';
import type { Plan } from '../lib/api';
import { cn } from '../lib/format';
import { href, type View } from '../lib/router';
import { useTheme } from '../lib/theme';
import { Logo } from './Logo';
import { Label } from './ui';

export const NAV: readonly { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'docs', label: 'Docs', icon: FileText },
  { view: 'list', label: 'List', icon: ListTodo },
  { view: 'board', label: 'Board', icon: Columns3 },
];

export function Sidebar({ name, plan, view }: { name: string; plan: Plan | null; view: View }) {
  const [theme, toggleTheme] = useTheme();
  const done = plan?.tasks.filter((t) => t.status === 'done').length ?? 0;
  const total = plan?.tasks.length ?? 0;

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel md:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
        <Logo className="size-7" />
        <span className="text-[15px] font-bold tracking-tight">dazza</span>
      </div>

      <div className="px-3 pt-4">
        <div className="rounded-lg border border-line bg-raised p-3">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-st-done transition-[width] duration-500"
                style={{ width: total ? `${(done / total) * 100}%` : 0 }}
              />
            </div>
            <span className="font-mono text-[11px] text-muted tabular-nums">
              {done}/{total}
            </span>
          </div>
        </div>
      </div>

      <nav className="mt-5 flex flex-col gap-0.5 px-3" aria-label="Views">
        <Label className="mb-2 px-2">Workspace</Label>
        {NAV.map(({ view: target, label, icon: Icon }) => (
          <a
            key={target}
            href={href(target)}
            aria-current={view === target ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
              view === target
                ? 'bg-raised text-ink shadow-[inset_2px_0_0_var(--accent)]'
                : 'text-muted hover:bg-raised/60 hover:text-ink',
            )}
          >
            <Icon className="size-4" strokeWidth={2.25} />
            {label}
          </a>
        ))}
      </nav>

      <div className="mt-auto space-y-3 p-3">
        <div className="rounded-lg border border-dashed border-line-strong p-3 text-xs leading-5 text-muted">
          Talk to Dazza in your terminal. This board updates live.
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted hover:bg-raised hover:text-ink"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </aside>
  );
}
