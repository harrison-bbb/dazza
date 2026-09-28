import { Check, ChevronRight, FileText, Flag, ListTodo } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { LiveActivity } from '../components/LiveActivity';
import { StatusIcon } from '../components/StatusIcon';
import { Button, Heading, Id, InlineText } from '../components/ui';
import { approvePlan, type Event, type Plan, type ProjectSnapshot, type Task } from '../lib/api';
import { timeAgo } from '../lib/format';
import { paths } from '../lib/router';
import { scopeSummary } from '../lib/scope';
import { blockerFor, latestUpdate, nextUp, statusSince } from '../lib/timeline';

const RECENT_LIMIT = 6;

/**
 * The manager's inbox. Top to bottom: what needs you, what's happening now,
 * the way into the plan, and what happened recently.
 */
export function Dashboard({ project, onChange }: { project: ProjectSnapshot; onChange(): void }) {
  const { plan, scope, events } = project;
  const tasks = plan?.tasks ?? [];
  const inScope = tasks.filter((t) => t.status !== 'cancelled');
  const closed = inScope.filter((t) => t.status === 'closed').length;
  // Tasks can build side by side.
  const building = tasks.filter((t) => t.status === 'building');
  const review = tasks.filter((t) => t.status === 'review');
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const next = plan && building.length === 0 ? nextUp(plan) : undefined;

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-14">
      <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
      {scope && (
        <p className="mt-1.5 text-ink-2">
          <InlineText>{scopeSummary(scope) ?? ''}</InlineText>
        </p>
      )}

      {inScope.length > 0 && (
        <div className="mt-6 flex items-center gap-3">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${(closed / inScope.length) * 100}%` }}
            />
          </div>
          <span className="text-[12px] text-muted tabular-nums">
            {closed} of {inScope.length} closed
            {project.buildLeft && ` · ${project.buildLeft} of building left`}
          </span>
        </div>
      )}

      {!plan && (
        <p className="mt-10 text-ink-2">
          No plan yet. Tell Dazza what you’re building in your terminal, and the plan will show up
          here.
        </p>
      )}

      {plan && !plan.approvedAt && <ApprovalRow count={tasks.length} onApproved={onChange} />}

      {(review.length > 0 || blocked.length > 0) && (
        <Section title="Needs you" count={review.length + blocked.length}>
          {blocked.map((task) => (
            <InboxRow
              key={task.id}
              task={task}
              detail={<span className="text-ink-2">“{blockerFor(events, task)?.message}”</span>}
              action="Answer"
            />
          ))}
          {review.map((task) => (
            <InboxRow
              key={task.id}
              task={task}
              detail={<Since label="Ready for review" at={statusSince(events, task)} />}
              action="Review"
            />
          ))}
        </Section>
      )}

      {plan?.approvedAt && (
        <Section title="Now">
          {building.length > 0 ? (
            building.map((task) => <NowRow key={task.id} task={task} events={events} />)
          ) : (
            <p className="py-3 text-[13px] text-muted">
              Dazza is idle.{' '}
              {next
                ? `Start \`dazza\` in your terminal and it picks up ${next.id} next.`
                : 'Nothing is ready to build.'}
            </p>
          )}
        </Section>
      )}

      {plan && plan.milestones.length > 0 && (
        <Section title="Milestones">
          <Milestones plan={plan} />
        </Section>
      )}

      <nav className="mt-10 divide-y divide-line border-y border-line" aria-label="Project">
        <HubLink href={paths.doc} icon={<FileText className="size-4" />} title="Scope of work">
          {scope ? 'What we’re building, and what we’re not' : 'Not written yet'}
        </HubLink>
        <HubLink href={paths.tasks} icon={<ListTodo className="size-4" />} title="Tasks">
          {taskSummary(tasks)}
        </HubLink>
        {project.report && (
          <HubLink href={paths.report} icon={<Flag className="size-4" />} title="Report">
            What was built, what changed, and what’s next
          </HubLink>
        )}
      </nav>

      {events.length > 0 && (
        <Section title="Recent">
          <RecentList events={events.slice(-RECENT_LIMIT).reverse()} tasks={tasks} />
        </Section>
      )}
    </div>
  );
}

/** Each stage the user can try, and how far along it is. */
function Milestones({ plan }: { plan: Plan }) {
  return (
    <ul className="divide-y divide-line">
      {plan.milestones.map((milestone) => {
        const tasks = plan.tasks.filter(
          (t) => milestone.tasks.includes(t.id) && t.status !== 'cancelled',
        );
        const closed = tasks.filter((t) => t.status === 'closed').length;
        const reached = tasks.length > 0 && closed === tasks.length;
        return (
          <li key={milestone.id} className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px]">
                <Id>{milestone.id}</Id>
                <span className={reached ? 'text-muted' : 'text-ink'}>{milestone.title}</span>
                {reached && <Check className="size-3.5 text-accent" strokeWidth={2.5} />}
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted">{milestone.goal}</p>
            </div>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${tasks.length ? (closed / tasks.length) * 100 : 0}%` }}
              />
            </div>
            <span className="w-10 text-right text-[12px] text-muted tabular-nums">
              {closed}/{tasks.length}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <Heading aside={count}>{title}</Heading>
      <div className="divide-y divide-line border-y border-line">{children}</div>
    </section>
  );
}

function InboxRow({ task, detail, action }: { task: Task; detail: ReactNode; action: string }) {
  return (
    <a
      href={paths.item(task.id)}
      className="group flex items-start gap-3 px-1 py-3 hover:bg-hover/50"
    >
      <StatusIcon status={task.status} className="mt-[5px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <Id>{task.id}</Id>
          <span className="truncate">
            <InlineText>{task.title}</InlineText>
          </span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{detail}</span>
      </span>
      <span className="mt-0.5 flex items-center gap-1 text-[13px] text-muted group-hover:text-ink">
        {action}
        <ChevronRight className="size-4" />
      </span>
    </a>
  );
}

function NowRow({ task, events }: { task: Task; events: Event[] }) {
  const update = latestUpdate(events, task);
  const done = task.subtasks.filter((s) => s.status === 'closed').length;
  return (
    <a href={paths.item(task.id)} className="group block px-1 py-3 hover:bg-hover/50">
      <span className="flex items-center gap-3">
        <StatusIcon status={task.status} />
        <Id>{task.id}</Id>
        <span className="min-w-0 flex-1 truncate">
          <InlineText>{task.title}</InlineText>
        </span>
        <ChevronRight className="size-4 text-faint group-hover:text-ink" />
      </span>
      <span className="mt-1 block pl-[26px] text-[13px] text-muted">
        <Since label="Building" at={statusSince(events, task)} />
        {task.subtasks.length > 0 && ` · ${done} of ${task.subtasks.length} subtasks`}
      </span>
      {update && (
        <span className="mt-1.5 line-clamp-2 block pl-[26px] text-[13px] text-ink-2">
          <InlineText>{update.message}</InlineText>{' '}
          <span className="text-faint">· {timeAgo(update.at)}</span>
        </span>
      )}
      <span className="mt-2 block pl-[26px]">
        <LiveActivity taskId={task.id} live limit={6} compact />
      </span>
    </a>
  );
}

function RecentList({ events, tasks }: { events: Event[]; tasks: Task[] }) {
  return (
    <ul className="py-1">
      {events.map((event) => {
        const task = tasks.find((t) => t.id === event.taskId?.split('.')[0]);
        return (
          <li
            key={`${event.at}-${event.type}-${event.message}`}
            className="flex gap-3 py-2 text-[13px]"
          >
            <span className="w-16 shrink-0 text-faint">{timeAgo(event.at)}</span>
            <span className="min-w-0 flex-1 truncate text-muted">
              <span className="text-ink-2">{event.actor === 'dazza' ? 'Dazza' : 'You'}</span>{' '}
              {event.type === 'comment' ? 'commented' : lowerFirst(event.message)}
              {event.taskId && task && (
                <>
                  {' on '}
                  <a href={paths.item(event.taskId)} className="text-ink-2 hover:text-ink">
                    {event.taskId}
                  </a>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Since({ label, at }: { label: string; at: string | undefined }) {
  return (
    <>
      {label}
      {at && ` · ${timeAgo(at)}`}
    </>
  );
}

function ApprovalRow({ count, onApproved }: { count: number; onApproved(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-8 flex items-center gap-4 rounded-lg border border-line-strong px-4 py-3">
      <p className="flex-1 text-[13px] text-ink-2">
        The plan is ready: {count} tasks. Read the scope and the tasks, then approve. Want changes?
        Tell Dazza in your terminal.
      </p>
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await approvePlan();
          setBusy(false);
          onApproved();
        }}
      >
        Approve plan
      </Button>
    </div>
  );
}

function HubLink(props: { href: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <a href={props.href} className="group flex items-center gap-3 px-1 py-4 hover:bg-hover/50">
      <span className="text-muted group-hover:text-ink">{props.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{props.title}</span>
        <span className="block truncate text-[13px] text-muted">{props.children}</span>
      </span>
      <ChevronRight className="size-4 text-faint group-hover:text-ink" />
    </a>
  );
}

function taskSummary(tasks: Task[]): string {
  if (tasks.length === 0) return 'None yet';
  const count = (status: Task['status']) => tasks.filter((t) => t.status === status).length;
  return [
    `${tasks.length} tasks`,
    count('planned') && `${count('planned')} planned`,
    count('backlog') && `${count('backlog')} in backlog`,
    count('closed') && `${count('closed')} closed`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
