import { ArrowLeft, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { Event } from '../lib/api';
import { cn, timeAgo } from '../lib/format';
import { paths } from '../lib/router';

const REVISION_TYPES: Event['type'][] = [
  'plan_created',
  'scope_change_proposed',
  'scope_changed',
  'plan_approved',
];

export function DocView({ scope, events }: { scope: string | null; events: Event[] }) {
  const history = events.filter((e) => REVISION_TYPES.includes(e.type)).reverse();

  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-14">
      <a
        href={paths.dashboard}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </a>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Scope of work</h1>
      {history.length > 0 && <History events={history} />}
      <div className="mt-10">
        {scope ? (
          <Markdown>{scope}</Markdown>
        ) : (
          <p className="text-muted">Dazza hasn’t written the scope yet.</p>
        )}
      </div>
    </article>
  );
}

/** Who wrote, revised and approved the scope, and why it changed. */
function History({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const latest = events[0];
  if (!latest) return null;

  return (
    <div className="mt-2 text-[13px] text-muted">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 hover:text-ink"
      >
        Updated {timeAgo(latest.at)} · {events.length} {events.length === 1 ? 'change' : 'changes'}
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="mt-3 space-y-2 border-l border-line pl-4">
          {events.map((event) => (
            <li key={`${event.at}-${event.type}`}>
              <span className="text-ink-2">{event.actor === 'dazza' ? 'Dazza' : 'You'}</span> ·{' '}
              {event.message} <span className="text-faint">· {timeAgo(event.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
