import { relative } from 'node:path';
import type { BuildEvent } from '../core/builder.js';
import { clock } from '../core/errors.js';
import { humanDuration } from '../core/estimates.js';
import { type Plan, SIZE_MINUTES } from '../core/schema.js';
import { McpTools } from '../mcp/server.js';
import { BRAND } from './banner.js';
import { paint, renderInline } from './style.js';

const DIFF_PREVIEW_LINES = 8;

/** Dazza's own tools: shown once they succeed, since a failed call is usually retried. */
const REPORTED_ON_SUCCESS = new Set<string>([
  McpTools.updateSubtask,
  McpTools.comment,
  McpTools.block,
  McpTools.submit,
]);

/** Tools that are plumbing rather than work. */
const HIDDEN_TOOLS = new Set(['TodoWrite', 'ToolSearch']);

export type BuildRenderer = (event: BuildEvent, plan: Plan | undefined) => string | undefined;

/**
 * Turn build events into terminal output, Claude Code style: the agent's
 * narration, each file it touches (with a short diff), commands it runs, and
 * subtasks as they close. Remembers Dazza's own tool calls until their result
 * arrives, so only successful ones are shown.
 */
export function createBuildRenderer(root: string): BuildRenderer {
  const pending = new Map<string, { tool: string; input: unknown }>();
  /** Tasks being built, and the worktree each is in, so paths read relative to it. */
  const active = new Map<string, string>();
  return (event, plan) => {
    if (event.type === 'task_started') active.set(event.task.id, event.dir ?? root);
    if (event.type === 'task_finished') active.delete(event.task.id);
    if (event.type !== 'agent') return renderBuildEvent(event, plan, root);

    const dir = active.get(event.task.id) ?? root;
    // With tasks building side by side, say which one each line is about.
    const tag = (text: string | undefined) =>
      text && active.size > 1
        ? text
            .split('\n')
            .map((line) => (line.trim() ? `${paint.dim(event.task.id)} ${line}` : line))
            .join('\n')
        : text;
    const agentEvent = event.event;
    if (agentEvent.type === 'tool_use' && REPORTED_ON_SUCCESS.has(agentEvent.tool)) {
      pending.set(agentEvent.id, agentEvent);
      return undefined;
    }
    if (agentEvent.type === 'tool_result') {
      const call = pending.get(agentEvent.id);
      pending.delete(agentEvent.id);
      return tag(call && agentEvent.ok ? toolLine(call.tool, call.input, plan, dir) : undefined);
    }
    return tag(renderBuildEvent(event, plan, dir));
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
          [
            `  on branch ${event.branch}`,
            event.task.size &&
              `usually ${humanDuration(SIZE_MINUTES[event.task.size]).replace('about ', '~')}`,
            milestoneOf(plan, event.task.id),
            '/stop to stop',
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ].join('\n');
    case 'task_finished':
      return finished(event, plan);
    case 'stopped':
      // Stopped for want of something from the user: point at the list of it.
      return `\n${marker()} ${event.reason}${event.idle && /review|blocked/.test(event.reason) ? paint.dim(' /review shows what’s waiting, and what to do about each.') : ''}`;
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

function agentLine(
  event: Extract<BuildEvent, { type: 'agent' }>['event'],
  plan: Plan | undefined,
  root: string,
): string | undefined {
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
  if (HIDDEN_TOOLS.has(tool)) return undefined;
  const step = (label: string, detail = '') =>
    `  ${paint.hex(BRAND, '⏺')} ${paint.bold(label)}${detail ? ` ${detail}` : ''}`;

  switch (tool) {
    case 'Read':
      return step('Read', paint.dim(path()));
    case 'Edit':
    case 'MultiEdit':
      return [
        step('Edit', path()),
        ...diffPreview(field('old_string') ?? '', field('new_string') ?? ''),
      ].join('\n');
    case 'Delete':
      return step('Delete', path());
    case 'Write': {
      const lines = (field('content') ?? '').split('\n').length;
      return step('Write', `${path()} ${paint.dim(`(${lines} lines)`)}`);
    }
    case 'Bash':
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
    case McpTools.submit:
      return `  ${paint.green('✔')} ${paint.bold('Handing over for review')}`;
    default:
      return step(tool.replace(/^mcp__\w+__/, ''));
  }
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
    return `\n${marker()} ${paint.bold(`${event.task.id} needs you`)}: answer here, on the board, or from your phone, and I’ll pick it back up. Moving on to the next task.`;
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

/** A few lines of red/green diff for an edit, like Claude Code shows. */
function diffPreview(before: string, after: string): string[] {
  const removed = before ? before.split('\n') : [];
  const added = after ? after.split('\n') : [];
  // Truncate before colouring, so a colour code is never cut in half.
  const lines = [
    ...removed.map((l) => paint.red(`- ${truncate(l, 100)}`)),
    ...added.map((l) => paint.green(`+ ${truncate(l, 100)}`)),
  ];
  const shown = lines.slice(0, DIFF_PREVIEW_LINES).map((l) => `      ${l}`);
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, paint.dim(`      … ${more} more lines`)] : shown;
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
