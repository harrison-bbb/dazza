import { FileText, Inbox } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { Label } from '../components/ui';
import type { Event } from '../lib/api';
import { timeAgo } from '../lib/format';
import { scopeSections } from '../lib/scope';

/** ClickUp-style doc page: doc list, the document, and an outline. */
export function Docs({ scope, events }: { scope: string; events: Event[] }) {
  const sections = scopeSections(scope);
  const updated = [...events]
    .reverse()
    .find((e) => e.type === 'plan_created' || e.type === 'scope_change_proposed');

  return (
    <div className="mx-auto flex max-w-7xl gap-8 p-4 sm:p-6">
      <nav className="hidden w-52 shrink-0 lg:block" aria-label="Documents">
        <Label className="mb-3 px-2">Documents</Label>
        <div className="flex items-center gap-2.5 rounded-lg bg-raised px-2.5 py-2 text-sm font-medium">
          <FileText className="size-4 text-accent-text" />
          Scope of work
        </div>
        <div className="mt-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted">
          <Inbox className="size-4" />
          Handoffs
          <span className="ml-auto rounded bg-raised px-1.5 font-mono text-[10px]">soon</span>
        </div>
      </nav>

      <article className="min-w-0 flex-1 rounded-xl border border-line bg-panel px-6 py-8 sm:px-10 sm:py-10">
        <div className="mb-8 border-b border-line pb-6">
          <div className="flex items-center gap-2 text-xs text-muted">
            <FileText className="size-3.5" />
            Scope of work
            {updated && <span>· updated {timeAgo(updated.at)}</span>}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Scope of work</h1>
          <p className="mt-2 text-sm text-muted">Written by Dazza from your conversation.</p>
        </div>
        <div className="max-w-3xl">
          <Markdown>{scope}</Markdown>
        </div>
      </article>

      <aside className="hidden w-48 shrink-0 xl:block">
        <div className="sticky top-6">
          <Label className="mb-3">On this page</Label>
          <ul className="space-y-1 border-l border-line">
            {sections.map((section) => (
              <li key={section.slug}>
                <button
                  type="button"
                  onClick={() =>
                    document.getElementById(section.slug)?.scrollIntoView({ behavior: 'smooth' })
                  }
                  className="-ml-px block border-l border-transparent py-1 pl-3 text-left text-sm text-muted hover:border-accent hover:text-ink"
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
