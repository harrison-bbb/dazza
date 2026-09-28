import { ArrowLeft, ChevronDown, Download, Pencil, Printer } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { StatusIcon } from '../components/StatusIcon';
import { Button, Id, InlineText } from '../components/ui';
import { type Event, type Plan, type ProjectSnapshot, saveScope, type Task } from '../lib/api';
import { cn, timeAgo } from '../lib/format';
import { paths } from '../lib/router';
import { planDocument, splitChangeLog } from '../lib/scope';
import { STATUS_LABEL } from '../lib/status';

const REVISION_TYPES: Event['type'][] = [
  'plan_created',
  'scope_change_proposed',
  'scope_changed',
  'plan_approved',
];

/**
 * The scope of work, as a project plan: the scope Dazza and the user agreed,
 * the deliverables and their acceptance criteria (always in step with the
 * tasks), and the change log. The user can edit the scope here.
 */
export function DocView({ project, onChange }: { project: ProjectSnapshot; onChange(): void }) {
  const { scope, plan, events } = project;
  const [editing, setEditing] = useState(false);
  const history = events.filter((e) => REVISION_TYPES.includes(e.type)).reverse();
  const { body, log } = splitChangeLog(scope ?? '');

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-14 print:max-w-none print:py-0">
      <a
        href={paths.dashboard}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink print:hidden"
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </a>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-semibold tracking-tight">Scope of work</h1>
        {scope && !editing && (
          <div className="flex gap-2 print:hidden">
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
            <Button variant="quiet" onClick={() => download(project)} title="Download as Markdown">
              <Download className="size-3.5" />
            </Button>
            <Button variant="quiet" onClick={() => window.print()} title="Print, or save as PDF">
              <Printer className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      {history.length > 0 && !editing && <History events={history} />}

      {!scope ? (
        <p className="mt-10 text-muted">Dazza hasn’t written the scope yet.</p>
      ) : editing ? (
        <Editor
          body={body}
          base={project.scopeVersion}
          approved={Boolean(plan?.approvedAt)}
          onDone={(saved) => {
            setEditing(false);
            if (saved) onChange();
          }}
        />
      ) : (
        <>
          <div className="mt-10">
            <Markdown>{body}</Markdown>
          </div>
          {plan && plan.tasks.length > 0 && <Deliverables plan={plan} />}
          {log && (
            <div className="mt-10">
              <Markdown>{log}</Markdown>
            </div>
          )}
        </>
      )}
    </article>
  );
}

/** Edit the scope's Markdown, with a preview. The change log stays Dazza's to keep. */
function Editor({
  body,
  base,
  approved,
  onDone,
}: {
  body: string;
  base: string;
  approved: boolean;
  onDone(saved: boolean): void;
}) {
  const [text, setText] = useState(body);
  const [summary, setSummary] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const changed = text !== body;

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    const result = await saveScope(text, base, summary);
    setBusy(false);
    if (result.ok) onDone(true);
    else setError(result.message);
  };

  const keys = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape' && !changed) onDone(false);
  };

  return (
    <div className="mt-8">
      <div className="flex items-center gap-4 border-b border-line text-[13px]">
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-1 py-2 capitalize',
              tab === t ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-faint">Markdown · ⌘S to save</span>
      </div>

      {tab === 'write' ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          spellCheck
          // biome-ignore lint/a11y/noAutofocus: the user just asked to edit.
          autoFocus
          className="mt-4 h-[65vh] w-full resize-y rounded-lg border border-line bg-transparent p-4 font-mono text-[13px] leading-6 text-ink outline-none focus:border-line-strong"
        />
      ) : (
        <div className="mt-6 min-h-[60vh]">
          <Markdown>{text}</Markdown>
        </div>
      )}

      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg py-3">
        {approved && (
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={keys}
            placeholder="What changed? (for the change log)"
            className="min-w-0 flex-1 rounded-md border border-line bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-line-strong"
          />
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="quiet" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!changed || busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="w-full text-[13px] text-red">{error}</p>}
        {approved && !error && (
          <p className="w-full text-[12px] text-muted">
            The plan is approved, so this goes in the change log as your edit, and Dazza and the
            builder work from the new version.
          </p>
        )}
      </div>
    </div>
  );
}

/** What gets delivered and how each piece is judged done, straight from the tasks. */
interface Group {
  key: string;
  heading: ReactNode;
  goal: string | undefined;
  tasks: Task[];
}

function Deliverables({ plan }: { plan: Plan }) {
  const groups: Group[] =
    plan.milestones.length > 0
      ? plan.milestones.map((m) => ({
          key: m.id,
          heading: (
            <>
              <Id>{m.id}</Id> {m.title}
            </>
          ),
          goal: m.goal,
          tasks: plan.tasks.filter((t) => m.tasks.includes(t.id)),
        }))
      : [{ key: 'all', heading: null, goal: undefined, tasks: plan.tasks }];
  const placed = new Set(plan.milestones.flatMap((m) => m.tasks));
  const other = plan.milestones.length > 0 ? plan.tasks.filter((t) => !placed.has(t.id)) : [];
  if (other.length > 0) {
    groups.push({ key: 'other', heading: <>Other</>, goal: undefined, tasks: other });
  }

  return (
    <section className="mt-10 break-inside-avoid">
      <h2 className="mb-1 text-[15px] font-semibold text-ink">
        Deliverables and acceptance criteria
      </h2>
      <p className="mb-5 text-[12px] text-muted">
        Kept in step with the tasks. Each is done when every one of its criteria is met.
      </p>
      {groups.map((group) => (
        <div key={group.key} className="mb-8 break-inside-avoid">
          {group.heading && (
            <h3 className="flex items-center gap-2 font-semibold text-ink">{group.heading}</h3>
          )}
          {group.goal && <p className="mt-0.5 mb-3 text-[13px] text-muted">{group.goal}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="w-[38%] py-2 pr-4 font-medium">Task</th>
                  <th className="py-2 pr-4 font-medium">Acceptance criteria</th>
                  <th className="w-24 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((task) => (
                  <Row key={task.id} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function Row({ task }: { task: Task }) {
  const cancelled = task.status === 'cancelled';
  return (
    <tr className="border-b border-line align-top">
      <td className="py-2.5 pr-4">
        <a href={paths.item(task.id)} className="group flex gap-2 hover:text-ink">
          <Id>{task.id}</Id>
          <span
            className={cn(
              'text-ink-2 group-hover:text-ink',
              cancelled && 'text-muted line-through',
            )}
          >
            <InlineText>{task.title}</InlineText>
            {task.size && (
              <span className="ml-1.5 font-mono text-[11px] text-faint">{task.size}</span>
            )}
          </span>
        </a>
      </td>
      <td className="py-2.5 pr-4">
        <ul className="space-y-1">
          {task.acceptanceCriteria.map((criterion, i) => {
            const report = task.handoff?.criteria[i];
            return (
              <li key={criterion} className={cn('text-ink-2', cancelled && 'text-muted')}>
                <span className={report ? (report.met ? 'text-accent' : 'text-red') : 'text-faint'}>
                  {report ? (report.met ? '✓ ' : '✗ ') : '· '}
                </span>
                <InlineText>{criterion}</InlineText>
              </li>
            );
          })}
        </ul>
      </td>
      <td className="py-2.5">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <StatusIcon status={task.status} />
          {STATUS_LABEL[task.status]}
        </span>
      </td>
    </tr>
  );
}

function download(project: ProjectSnapshot): void {
  if (!project.scope) return;
  const blob = new Blob([planDocument(project.name, project.scope, project.plan)], {
    type: 'text/markdown',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${project.name}-scope-of-work.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Who wrote, revised and approved the scope, and why it changed. */
function History({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const latest = events[0];
  if (!latest) return null;

  return (
    <div className="mt-2 text-[13px] text-muted print:hidden">
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
