import { relative } from 'node:path';
import type { BuildEvent } from '../core/builder.js';
import { clock } from '../core/errors.js';
import { humanDuration } from '../core/estimates.js';
import { type Plan, SIZE_MINUTES } from '../core/schema.js';
import { MCP_SERVER_NAME } from '../mcp/name.js';
import { McpTools } from '../mcp/server.js';
import type { AgentEvent, Compacted } from '../providers/types.js';
import { BRAND } from './banner.js';
import { paint, renderInline } from './style.js';

/** Dazza's own tools: shown once they succeed, since a failed call is usually retried. */
const REPORTED_ON_SUCCESS = new Set<string>([
  McpTools.updateSubtask,
  McpTools.comment,
  McpTools.block,
  McpTools.askPermission,
  McpTools.submit,
  McpTools.savePlan,
  McpTools.updateItem,
  McpTools.addTask,
  McpTools.addSubtask,
  McpTools.setStatus,
  McpTools.updateScope,
  McpTools.approvePlan,
  McpTools.prioritise,
  McpTools.writeReport,
  McpTools.redoTask,
  McpTools.answerPermission,
]);

/** Once a builder has asked the user something, it's waiting; anything it adds is noise. */
const ASKING = new Set<string>([McpTools.block, McpTools.askPermission]);

export type BuildRenderer = (event: BuildEvent, plan: Plan | undefined) => string | undefined;

/**
 * One agent's steps as terminal lines, the way Claude Code shows them: its
 * narration, each file it changes (with a short diff), the commands that do
 * something, and Dazza's own actions once they succeed. Looking around (reading
 * files, searching, `ls`) is grouped into one line, shown before whatever it
 * does next. Used for each builder, and for the chat.
 */
export interface StepTracker {
  /** The line(s) for one agent event, if it's worth showing. */
  step(event: AgentEvent, plan: Plan | undefined, dir: string): string | undefined;
  /** The grouped "Read 3 files" line not shown yet, e.g. before a reply. */
  flush(): string | undefined;
}

export function createStepTracker(): StepTracker {
  const pending = new Map<string, { tool: string; input: unknown }>();
  let looked = { files: 0, searches: 0 };
  /** It asked the user something: it's waiting, and anything it adds is noise. */
  let asked = false;
  const flush = () => {
    const line = looked.files + looked.searches > 0 ? lookedLine(looked) : undefined;
    looked = { files: 0, searches: 0 };
    return line;
  };
  // Whatever it looked at first, in one line, then what it did.
  const withLooked = (text: string | undefined) => {
    if (!text) return undefined;
    const seen = flush();
    return seen ? `${seen}\n${text}` : text;
  };
  return {
    flush,
    step(event, plan, dir) {
      const looking = event.type === 'tool_use' && lookKind(event.tool, event.input);
      if (looking) {
        looked[looking === 'file' ? 'files' : 'searches'] += 1;
        return undefined;
      }
      if (event.type === 'tool_use' && REPORTED_ON_SUCCESS.has(event.tool)) {
        pending.set(event.id, event);
        return undefined;
      }
      if (event.type === 'tool_result') {
        const call = pending.get(event.id);
        pending.delete(event.id);
        if (call && event.ok && ASKING.has(call.tool)) asked = true;
        return withLooked(
          call && event.ok ? toolLine(call.tool, call.input, plan, dir) : undefined,
        );
      }
      if (event.type === 'text' && asked) return undefined;
      return withLooked(agentLine(event, plan, dir));
    },
  };
}

/**
 * Build events as terminal output: each task's steps (see StepTracker), and the
 * build's own news (a task starting, finishing, waiting on a limit).
 */
export function createBuildRenderer(root: string): BuildRenderer {
  /** Tasks being built, and the worktree each is in, so paths read relative to it. */
  const active = new Map<string, string>();
  const steps = new Map<string, StepTracker>();
  const stepsFor = (taskId: string) => {
    const existing = steps.get(taskId);
    if (existing) return existing;
    const tracker = createStepTracker();
    steps.set(taskId, tracker);
    return tracker;
  };
  return (event, plan) => {
    if (event.type === 'task_started') active.set(event.task.id, event.dir ?? root);
    // Each run of a task starts afresh.
    if (event.type === 'task_started' || event.type === 'task_finished')
      steps.delete(event.task.id);
    if (event.type === 'task_finished') active.delete(event.task.id);
    if (event.type !== 'agent') return renderBuildEvent(event, plan, root);

    const text = stepsFor(event.task.id).step(event.event, plan, active.get(event.task.id) ?? root);
    // With tasks building side by side, say which one each line is about.
    return text && active.size > 1
      ? text
          .split('\n')
          .map((line) => (line.trim() ? `${paint.dim(event.task.id)} ${line}` : line))
          .join('\n')
      : text;
  };
}

/** Render one event on its own, with no memory of earlier ones. */
export function renderBuildEvent(
  event: BuildEvent,
  plan: Plan | undefined,
  root: string,
): string | undefined {
  switch (event.type) {
    case 'repo_created':
      return `${marker()} Set up a git repository here, with your existing files as the first commit.`;
    case 'task_started':
      return [
        '',
        `${marker()} ${paint.bold(`${event.resumed ? 'Picking up' : 'Building'} ${event.task.id}`)} · ${event.task.title}`,
        paint.dim(
          `  ${[
            event.task.size &&
              `usually ${humanDuration(event.minutes ?? SIZE_MINUTES[event.task.size]).replace('about ', '~')}`,
            milestoneOf(plan, event.task.id),
            '/stop to stop',
          ]
            .filter(Boolean)
            .join(' · ')}`,
        ),
      ].join('\n');
    case 'task_finished':
      return finished(event, plan);
    case 'stopped':
      // Stopped for want of something from the user: point at the list of it.
      return `\n${marker()} ${event.reason}${event.idle && /review|answer/.test(event.reason) ? paint.dim(' /review shows what’s waiting, and what to do about each.') : ''}`;
    case 'waiting':
      return event.reason === 'usage_limit'
        ? `\n${marker()} ${paint.bold('Usage limit reached.')} ${event.task.id} is paused; I’ll pick it back up at ${clock(event.until)}. Keep Dazza open, or Ctrl-C to stop.`
        : `  ${paint.dim(`The model is overloaded; trying again at ${clock(event.until)}.`)}`;
    case 'retrying':
      return `  ${paint.dim(`↻ ${event.reason}`)}`;
    case 'agent':
      return agentLine(event.event, plan, root);
  }
}

/** "Compacted to make room (55k → 2k tokens)": the agent summarised its conversation. */
export function compactedLine(event: Compacted, what = 'its context'): string {
  const sizes =
    event.before !== undefined && event.after !== undefined
      ? ` (${tokens(event.before)} → ${tokens(event.after)} tokens)`
      : '';
  const why = event.trigger === 'auto' ? ' to make room' : '';
  return `  ${paint.dim(`• Compacted ${what}${why}${sizes}`)}`;
}

/** 55131 → "55k". */
function tokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

function agentLine(
  event: Extract<BuildEvent, { type: 'agent' }>['event'],
  plan: Plan | undefined,
  root: string,
): string | undefined {
  if (event.type === 'compacted') return compactedLine(event);
  if (event.type === 'text') {
    const text = event.text.trim();
    return text ? indent(renderInline(text)) : undefined;
  }
  if (event.type !== 'tool_use') return undefined;
  return toolLine(event.tool, event.input, plan, root);
}

/** One tool call, as a line (plus a diff preview for edits). Exported for tests. */
export function toolLine(
  tool: string,
  input: unknown,
  plan: Plan | undefined,
  root: string,
): string | undefined {
  const field = (name: string) => {
    const value =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)[name]
        : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const path = (name = 'file_path') => {
    const value = field(name);
    return value ? relative(root, value) || value : '';
  };
  // A plain bullet: ⏺ renders as a coloured emoji in many terminals.
  const step = (label: string, detail = '') =>
    `  ${paint.hex(BRAND, '•')} ${paint.bold(label)}${detail ? ` ${detail}` : ''}`;

  switch (tool) {
    case 'Read':
      return step('Read', paint.dim(path()));
    case 'Edit':
      return [
        step('Edit', `${path()}${changeSize(field('old_string'), field('new_string'))}`),
        ...diffPreview(field('old_string') ?? '', field('new_string') ?? ''),
      ].join('\n');
    case 'Delete':
      return step('Delete', path());
    case 'NotebookEdit':
      return step('Edit', path('notebook_path'));
    case 'Write': {
      const lines = (field('content') ?? '').split('\n').length;
      return step('Write', `${path()} ${paint.dim(`(${lines} lines)`)}`);
    }
    case 'Bash':
    case 'Monitor':
      return step('Run', paint.dim(truncate(field('command') ?? '', 90)));
    case 'Glob':
    case 'Grep':
      return step('Search', paint.dim(field('pattern') ?? ''));
    case 'WebFetch':
    case 'WebSearch':
      return step('Look up', paint.dim(field('url') ?? field('query') ?? ''));
    case McpTools.updateSubtask: {
      const id = field('id') ?? '';
      const title = plan?.tasks.flatMap((t) => t.subtasks).find((s) => s.id === id)?.title ?? '';
      return field('status') === 'closed'
        ? `  ${paint.green('✔')} ${paint.dim(id)} ${title}`
        : `  ${paint.dim('○')} ${paint.dim(`${id} ${title}`)}`;
    }
    case McpTools.screenshot: {
      const target = field('selector') ?? field('path') ?? field('url') ?? '/';
      return step('Screenshot', paint.dim(`${target} (${field('device') ?? 'desktop'})`));
    }
    case McpTools.comment:
      return step('Note', paint.dim(truncate(field('body') ?? '', 90)));
    case McpTools.block:
      return `  ${paint.red('!')} ${paint.bold('Needs you:')} ${field('question') ?? ''}`;
    case McpTools.askPermission:
      return `  ${paint.red('!')} ${paint.bold('Asks to run:')} ${field('command') ?? ''}${field('why') ? paint.dim(` · ${field('why')}`) : ''}`;
    case McpTools.submit:
      return `  ${paint.green('✔')} ${paint.bold('Handing over for review')}`;
    // The chat's own changes to the project.
    case McpTools.savePlan:
      return step('Saved the plan');
    case McpTools.updateItem:
      return step('Updated', field('id') ?? '');
    case McpTools.addTask:
      return step('Added a task', field('title') ?? '');
    case McpTools.addSubtask:
      return step('Added a subtask to', field('taskId') ?? '');
    case McpTools.setStatus:
      return step('Moved', `${field('id') ?? ''} to ${field('status') ?? ''}`);
    case McpTools.updateScope:
      return step('Updated the scope', paint.dim(field('summary') ?? ''));
    case McpTools.approvePlan:
      return step('Approved the plan');
    case McpTools.prioritise:
      return step('Reordered the tasks');
    case McpTools.writeReport:
      return step('Wrote the report');
    case McpTools.redoTask:
      return step('Started over', field('id') ?? '');
    case McpTools.answerPermission:
      return step(
        (input as { allow?: unknown } | undefined)?.allow === true ? 'Allowed' : 'Didn’t allow',
        `${field('taskId') ?? ''}’s command`,
      );
    default: {
      // The user's own MCP servers: "Claude Docs · guide", "Gmail · search_threads".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (mcp?.[1] && mcp[2] && mcp[1] !== MCP_SERVER_NAME) {
        return step(mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' '), paint.dim(`· ${mcp[2]}`));
      }
      // Plumbing (ToolSearch, say), or a tool this view doesn't know: not worth a line.
      return undefined;
    }
  }
}

/** Reading and searching: looking around, rather than doing. */
function lookKind(tool: string, input: unknown): 'file' | 'search' | undefined {
  if (tool === 'Read') return 'file';
  if (tool === 'Glob' || tool === 'Grep') return 'search';
  if (tool !== 'Bash' || typeof input !== 'object' || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' && readOnly(command) ? 'search' : undefined;
}

const READ_ONLY =
  /^(ls|cat|head|tail|wc|pwd|tree|file|stat|which|rg|grep|find(?!.*(-delete|-exec))|sed -n|git (status|log|diff|show|branch)|npm (ls|view)|node -v|npm -v)\b/;

/** A shell command that only looks: every part of it, and no redirect into a file. */
function readOnly(command: string): boolean {
  if (/>(?!&)/.test(command.replace(/2>(&1|\/dev\/null)/g, ''))) return false;
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => READ_ONLY.test(part));
}

function lookedLine({ files, searches }: { files: number; searches: number }): string {
  const parts = [
    files > 0 && `Read ${files} ${files === 1 ? 'file' : 'files'}`,
    searches > 0 && `${searches} ${searches === 1 ? 'search' : 'searches'}`,
  ].filter(Boolean);
  return `  ${paint.dim(`• ${parts.join(' · ')}`)}`;
}

/** The first few lines of an edit, red and green, as Claude Code shows them. */
const DIFF_LINES = 6;

function diffPreview(before: string, after: string): string[] {
  const lines = [
    ...(before ? before.split('\n') : []).map((l) => paint.red(`- ${truncate(l, 100)}`)),
    ...(after ? after.split('\n') : []).map((l) => paint.green(`+ ${truncate(l, 100)}`)),
  ];
  const shown = lines.slice(0, DIFF_LINES).map((l) => `      ${l}`);
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, paint.dim(`      … ${more} more lines`)] : shown;
}

/** " (+12 −3)": how much an edit changed. */
function changeSize(before: string | undefined, after: string | undefined): string {
  const lines = (text: string | undefined) => (text ? text.split('\n').length : 0);
  const added = lines(after);
  const removed = lines(before);
  return added || removed ? ` ${paint.dim(`(+${added} −${removed})`)}` : '';
}

function finished(
  event: Extract<BuildEvent, { type: 'task_finished' }>,
  plan: Plan | undefined,
): string {
  const task = plan?.tasks.find((t) => t.id === event.task.id);
  if (event.outcome === 'paused') {
    return `\n${marker()} Stopped. ${event.task.id} is paused and picks up where it left off on the next /build.`;
  }
  if (event.outcome === 'blocked') {
    return `\n${marker()} ${paint.bold(`${event.task.id} needs you`)}: answer here, on the board, or from your phone, and I’ll pick it back up.`;
  }
  const handoff = task?.handoff;
  const checks = handoff?.checks ?? [];
  const failed = checks.filter((c) => !c.passed).length;
  const criteria = handoff?.criteria ?? [];
  const unmet = criteria.filter((c) => !c.met);
  const details = [
    criteria.length > 0 &&
      (unmet.length
        ? paint.red(`${unmet.length} of ${criteria.length} criteria not met`)
        : `all ${criteria.length} criteria met`),
    handoff?.filesChanged !== undefined &&
      `${handoff.filesChanged} ${handoff.filesChanged === 1 ? 'file' : 'files'} changed`,
    checks.length > 0 &&
      (failed
        ? paint.red(`${failed} ${failed === 1 ? 'check' : 'checks'} failing`)
        : `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`),
  ].filter(Boolean);
  return [
    '',
    `${marker()} ${paint.bold(`${event.task.id} is ready for your review`)}${details.length ? ` · ${details.join(' · ')}` : ''}`,
    ...(handoff ? [indent(renderInline(handoff.summary))] : []),
    ...unmet.map((c) => indent(paint.red(`✗ ${c.criterion}: ${c.evidence}`))),
    // What to do next, without looking anything up.
    indent(
      paint.dim(
        `/accept ${event.task.id} to merge it · /changes ${event.task.id} <what to change> · /try ${event.task.id} to run it first`,
      ),
    ),
  ].join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function marker(): string {
  return paint.hex(BRAND, '●');
}

function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "towards M2 Sync", for a task in a milestone. */
function milestoneOf(plan: Plan | undefined, taskId: string): string | undefined {
  const milestone = plan?.milestones.find((m) => m.tasks.includes(taskId));
  return milestone && `towards ${milestone.id} ${milestone.title}`;
}
