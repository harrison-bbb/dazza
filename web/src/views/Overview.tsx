import { ArrowRight, FileText, type LucideIcon, Sparkles } from 'lucide-react';
import { ActivityFeed } from '../components/ActivityFeed';
import { SubtaskBlocks, TaskStrip } from '../components/Blocks';
import { StatusDonut } from '../components/Donut';
import { ApproveButton } from '../components/Header';
import { Markdown } from '../components/Markdown';
import { StatusChip } from '../components/StatusChip';
import { Card, CardHeader, InlineText, TaskId } from '../components/ui';
import type { Plan, ProjectSnapshot, Task } from '../lib/api';
import { cn } from '../lib/format';
import { href } from '../lib/router';
import { needsFromYou, scopeSections } from '../lib/scope';
import { laneOf, STATUS } from '../lib/status';

interface OverviewProps {
  project: ProjectSnapshot & { plan: Plan };
  onChange(): void;
}

export function Overview({ project, onChange }: OverviewProps) {
  const { plan, scope, events } = project;
  const tasks = plan.tasks;
  const count = (lane: Task['status']) => tasks.filter((t) => laneOf(t) === lane).length;
  const next = nextUp(tasks);
  const needs = scope ? needsFromYou(scope) : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      {!plan.approvedAt && <ApprovalBanner taskCount={tasks.length} onApproved={onChange} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tasks" value={tasks.length} hint={`${subtaskCount(tasks)} subtasks`} />
        <StatTile label="Done" value={count('done')} status="done" />
        <StatTile label="In progress" value={count('in_progress')} status="in_progress" />
        <StatTile
          label="Needs you"
          value={count('blocked') + count('review')}
          hint="Blocked or in review"
          status={count('blocked') > 0 ? 'blocked' : 'review'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Progress" />
          <div className="px-5 pb-5">
            <StatusDonut tasks={tasks} />
          </div>
        </Card>

        <Card className="flex flex-col lg:col-span-3">
          <CardHeader
            title="Roadmap"
            action={
              <a href={href('board')} className="text-xs font-medium text-muted hover:text-ink">
                Open board →
              </a>
            }
          />
          <div className="px-5">
            <TaskStrip tasks={tasks} />
          </div>
          {next && <UpNext task={next} />}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-2">
          {needs && (
            <Card>
              <CardHeader title="What Dazza needs from you" />
              <div className="px-5 pb-3 text-sm [&_li]:leading-6 [&_p]:my-1.5">
                <Markdown>{needs}</Markdown>
              </div>
            </Card>
          )}
          {scope && <DocsCard scope={scope} />}
        </div>

        <Card className="lg:col-span-3">
          <CardHeader title="Activity" />
          <ActivityFeed events={events} limit={8} />
        </Card>
      </div>
    </div>
  );
}

function ApprovalBanner({ taskCount, onApproved }: { taskCount: number; onApproved(): void }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-accent/40 bg-accent/[0.07] p-5 sm:p-6">
      <div
        className="pointer-events-none absolute -top-10 -right-10 size-48 rounded-3xl bg-accent/10 blur-2xl"
        aria-hidden
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink">
          <Sparkles className="size-5" strokeWidth={2.5} />
        </span>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">
            The plan is ready for your review
          </h1>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            {taskCount} tasks. Read the scope, check the tasks, then approve so Dazza can start
            building. Want changes? Just tell Dazza in the terminal.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={href('docs')}
            className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3.5 text-sm font-semibold text-ink-2 hover:text-ink"
          >
            Read scope
          </a>
          <ApproveButton onApproved={onApproved} />
        </div>
      </div>
    </div>
  );
}

interface StatTileProps {
  label: string;
  value: number;
  hint?: string;
  status?: Task['status'];
}

function StatTile({ label, value, hint, status }: StatTileProps) {
  const meta = status ? STATUS[status] : undefined;
  const Icon: LucideIcon | undefined = meta?.icon;
  return (
    <Card className="relative overflow-hidden p-4 sm:p-5">
      {meta && <span className={cn('absolute inset-x-0 top-0 h-1', meta.fill)} aria-hidden />}
      <div className="flex items-center gap-1.5 text-sm text-muted">
        {Icon && <Icon className={cn('size-3.5', meta?.text)} strokeWidth={2.5} />}
        {label}
      </div>
      <div className="mt-2 text-4xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

function UpNext({ task }: { task: Task }) {
  return (
    <a
      href={href('list', task.id)}
      className="group m-5 block rounded-lg border border-line bg-raised/50 p-4 transition hover:border-line-strong"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          {task.status === 'todo' ? 'Up next' : 'Current'}
        </span>
        <StatusChip status={task.status} />
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <TaskId id={task.id} />
        <span className="font-semibold">{task.title}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-muted">
        <InlineText>{task.description}</InlineText>
      </p>
      <div className="mt-3 flex items-center justify-between">
        <SubtaskBlocks subtasks={task.subtasks} />
        <ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
    </a>
  );
}

function DocsCard({ scope }: { scope: string }) {
  const sections = scopeSections(scope);
  return (
    <Card>
      <CardHeader title="Docs" />
      <a
        href={href('docs')}
        className="group mx-5 mb-5 flex items-center gap-3 rounded-lg border border-line bg-raised/50 p-3 hover:border-line-strong"
      >
        <span className="grid size-9 place-items-center rounded-md bg-panel ring-1 ring-line">
          <FileText className="size-4 text-accent-text" />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-semibold">Scope of work</span>
          <span className="block text-xs text-muted">{sections.length} sections</span>
        </span>
        <ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
      </a>
    </Card>
  );
}

/** The task in flight, or the next one ready to start. */
function nextUp(tasks: Task[]): Task | undefined {
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return (
    tasks.find((t) => t.status === 'in_progress') ??
    tasks.find((t) => t.status === 'todo' && t.dependsOn.every((d) => done.has(d)))
  );
}

function subtaskCount(tasks: Task[]): number {
  return tasks.reduce((sum, t) => sum + t.subtasks.length, 0);
}
