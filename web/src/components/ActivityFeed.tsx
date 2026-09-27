import {
  BadgeCheck,
  CircleCheck,
  FilePlus2,
  GitPullRequestArrow,
  type LucideIcon,
  MessageSquare,
  OctagonAlert,
  Play,
  RotateCcw,
  Send,
  Zap,
} from 'lucide-react';
import type { Event } from '../lib/api';
import { timeAgo } from '../lib/format';
import { href } from '../lib/router';
import { TaskId } from './ui';

const ICONS: Record<Event['type'], LucideIcon> = {
  plan_created: FilePlus2,
  plan_approved: BadgeCheck,
  task_started: Play,
  task_progress: Zap,
  task_blocked: OctagonAlert,
  task_submitted: Send,
  task_approved: CircleCheck,
  task_rejected: RotateCcw,
  scope_change_proposed: GitPullRequestArrow,
  comment: MessageSquare,
};

/** Newest-first timeline of what happened on the project. */
export function ActivityFeed({ events, limit }: { events: Event[]; limit?: number }) {
  const items = [...events].reverse().slice(0, limit);
  if (items.length === 0) {
    return <p className="px-5 pb-5 text-sm text-muted">Nothing yet.</p>;
  }

  return (
    <ol className="px-5 pb-4">
      {items.map((event, i) => {
        const Icon = ICONS[event.type];
        return (
          <li
            key={`${event.at}-${event.type}-${event.message}`}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            {i < items.length - 1 && (
              <span className="absolute top-8 bottom-1 left-[13px] w-px bg-line" aria-hidden />
            )}
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised">
              <Icon className="size-3.5 text-ink-2" strokeWidth={2.25} />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-sm leading-5 text-ink-2">
                {event.type === 'comment' && <span className="font-medium text-ink">You: </span>}
                {event.message}
              </p>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                {event.taskId && (
                  <a href={href('list', event.taskId)} className="hover:text-ink">
                    <TaskId id={event.taskId} />
                  </a>
                )}
                <time dateTime={event.at}>{timeAgo(event.at)}</time>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
