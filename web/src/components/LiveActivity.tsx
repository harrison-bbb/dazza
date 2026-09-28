import { useEffect, useRef, useState } from 'react';
import { type Activity, fetchActivity } from '../lib/api';
import { cn, timeAgo } from '../lib/format';

/** How often to look for new steps while a task is building. */
const POLL_MS = 1_500;

/**
 * What a task's builder is doing, step by step, in plain words. Follows along
 * while it builds; afterwards it's the record of how the task was built.
 */
export function LiveActivity({
  taskId,
  live,
  limit = 200,
  compact = false,
}: {
  taskId: string;
  /** Building now: keep fetching, and stay scrolled to the latest step. */
  live: boolean;
  limit?: number;
  /** A few lines, for the dashboard. */
  compact?: boolean;
}) {
  const [entries, setEntries] = useState<Activity[]>();
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const next = await fetchActivity(taskId, limit);
      if (!stopped) setEntries(next);
    };
    void load();
    if (!live)
      return () => {
        stopped = true;
      };
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [taskId, live, limit]);

  // Follow the latest step, unless the user has scrolled up to read.
  const count = entries?.length ?? 0;
  useEffect(() => {
    const el = list.current;
    if (!el || !live || count === 0) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [count, live]);

  if (!entries) return null;
  if (entries.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        {live ? 'Getting started…' : 'Nothing recorded yet.'}
      </p>
    );
  }
  return (
    <ol
      ref={list}
      className={cn(
        'space-y-1 overflow-y-auto font-[450] text-[13px] leading-6',
        compact ? 'max-h-40' : 'max-h-[28rem]',
      )}
    >
      {entries.map((entry) => (
        <li key={`${entry.at}-${entry.kind}-${entry.text}`} className="flex gap-3">
          <span className="w-14 shrink-0 text-right text-[11px] leading-6 text-faint tabular-nums">
            {timeAgo(entry.at)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1',
              entry.kind === 'say' && 'text-ink-2',
              entry.kind === 'do' && 'truncate font-mono text-[12px] text-muted',
              entry.kind === 'status' && 'font-medium text-ink',
            )}
            title={entry.kind === 'do' ? entry.text : undefined}
          >
            {entry.text}
          </span>
        </li>
      ))}
      {live && (
        <li className="flex gap-3">
          <span className="w-14" />
          <span className="flex items-center gap-2 text-[12px] text-accent">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            Working
          </span>
        </li>
      )}
    </ol>
  );
}
