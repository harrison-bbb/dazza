import { ChevronRight, FileText, ListTodo } from 'lucide-react';
import { useState } from 'react';
import { StatusIcon } from '../components/StatusIcon';
import { Button, Heading, Id } from '../components/ui';
import { approvePlan, type ProjectSnapshot, type Task } from '../lib/api';
import { paths } from '../lib/router';
import { scopeSummary } from '../lib/scope';
import { STATUS_LABEL } from '../lib/status';

/** The hub: what's happening now, what needs you, and the way into the doc and the list. */
export function Dashboard({ project, onChange }: { project: ProjectSnapshot; onChange(): void }) {
  const { plan, scope } = project;
  const tasks = plan?.tasks ?? [];
  const inScope = tasks.filter((t) => t.status !== 'cancelled');
  const closed = inScope.filter((t) => t.status === 'closed').length;
  const building = tasks.find((t) => t.status === 'building');
  const waiting = tasks.filter((t) => t.status === 'review' || t.status === 'blocked');

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-14">
      <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
      <p className="mt-1.5 text-ink-2">{summary(project, building)}</p>

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
          </span>
        </div>
      )}

      {plan && !plan.approvedAt && <ApprovalRow count={tasks.length} onApproved={onChange} />}

      <nav className="mt-10 divide-y divide-line border-y border-line" aria-label="Project">
        <HubLink
          href={paths.doc}
          icon={<FileText className="size-4" />}
          title="Scope of work"
          detail={(scope && scopeSummary(scope)) || 'Not written yet'}
        />
        <HubLink
          href={paths.tasks}
          icon={<ListTodo className="size-4" />}
          title="Tasks"
          detail={taskSummary(tasks)}
        />
      </nav>

      {building && (
        <section className="mt-10">
          <Heading>Building now</Heading>
          <TaskRow task={building} />
        </section>
      )}

      {waiting.length > 0 && (
        <section className="mt-10">
          <Heading>Waiting on you</Heading>
          <div className="divide-y divide-line border-y border-line">
            {waiting.map((task) => (
              <TaskRow key={task.id} task={task} note={STATUS_LABEL[task.status]} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function summary(project: ProjectSnapshot, building: Task | undefined): string {
  if (!project.plan) return 'No plan yet. Tell Dazza what you’re building in your terminal.';
  if (!project.plan.approvedAt) return 'The plan is ready for your review.';
  if (building) return `Dazza is building ${building.id}: ${building.title}.`;
  if (project.plan.tasks.every((t) => t.status === 'closed' || t.status === 'cancelled')) {
    return 'Everything is closed.';
  }
  return 'Dazza is idle. Start `dazza` in your terminal to pick up the next task.';
}

function taskSummary(tasks: Task[]): string {
  if (tasks.length === 0) return 'None yet';
  const count = (status: Task['status']) => tasks.filter((t) => t.status === status).length;
  return [
    `${tasks.length} tasks`,
    count('review') && `${count('review')} in review`,
    count('blocked') && `${count('blocked')} blocked`,
    count('closed') && `${count('closed')} closed`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function ApprovalRow({ count, onApproved }: { count: number; onApproved(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-8 flex items-center gap-4 rounded-lg border border-line-strong px-4 py-3">
      <p className="flex-1 text-[13px] text-ink-2">
        Read the scope and the {count} tasks. Approve when you’re happy, or tell Dazza what to
        change.
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

function HubLink(props: { href: string; icon: React.ReactNode; title: string; detail: string }) {
  return (
    <a href={props.href} className="group flex items-center gap-3 px-1 py-4 hover:bg-hover/50">
      <span className="text-muted group-hover:text-ink">{props.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{props.title}</span>
        <span className="block truncate text-[13px] text-muted">{props.detail}</span>
      </span>
      <ChevronRight className="size-4 text-faint group-hover:text-ink" />
    </a>
  );
}

function TaskRow({ task, note }: { task: Task; note?: string }) {
  return (
    <a
      href={paths.item(task.id)}
      className="group flex items-center gap-3 px-1 py-3 hover:bg-hover/50"
    >
      <StatusIcon status={task.status} />
      <Id>{task.id}</Id>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {note && <span className="text-[12px] text-muted">{note}</span>}
      <ChevronRight className="size-4 text-faint group-hover:text-ink" />
    </a>
  );
}
