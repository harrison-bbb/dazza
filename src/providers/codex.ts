import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import type { Connection } from '../core/config.js';
import { resolveCommand } from '../util/command.js';
import { execCommand, runInteractive, shellCommand, spawnLines } from '../util/process.js';
import { capitalize, parseJson } from '../util/text.js';
import { classifyError, isHopeless } from './errors.js';
import type {
  AgentError,
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
  Compacted,
  ModelOption,
  ProviderStatus,
  UsageWindow,
} from './types.js';

/**
 * Drives the user's installed `codex` CLI: `codex exec --json` for work, and
 * Codex's app-server (JSON-RPC over stdio) for the model list, the account and
 * live usage limits, none of which spend tokens.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly name = 'Codex';
  private readonly bin: string;
  private readonly connection: Connection | undefined;

  constructor(options: { bin?: string; connection?: Connection } = {}) {
    this.bin = options.bin ?? 'codex';
    this.connection = options.connection;
  }

  /**
   * The environment Codex runs with. With an API key, Dazza passes it in; on a
   * ChatGPT sign-in, stray keys in the user's shell are removed so they can't
   * quietly switch billing.
   */
  private env(): NodeJS.ProcessEnv {
    const { OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ...env } = process.env;
    return this.connection?.method === 'api-key'
      ? { ...env, CODEX_API_KEY: this.connection.apiKey }
      : env;
  }

  async detect(): Promise<ProviderStatus> {
    const version = await execCommand(this.bin, ['--version'], this.env());
    if (version === undefined || version.exitCode !== 0) return { installed: false };
    const account = await this.appServer('account/read', {}, AccountResponse).catch(
      () => undefined,
    );
    const plan =
      account?.account && 'planType' in account.account ? account.account.planType : undefined;
    return {
      installed: true,
      version: version.stdout.trim().split(' ').at(-1) ?? 'unknown',
      loggedIn: this.connection?.method === 'api-key' || Boolean(account?.account),
      ...(account?.account && {
        authMethod: account.account.type === 'chatgpt' ? 'ChatGPT' : 'API key',
      }),
      ...(plan && { plan: `ChatGPT ${capitalize(plan)}` }),
    };
  }

  /** Hand the terminal to `codex login` so the user can sign in with ChatGPT. */
  async signIn(): Promise<void> {
    await runInteractive(this.bin, ['login']);
  }

  async listModels(): Promise<ModelOption[]> {
    const { data } = await this.appServer('model/list', {}, ModelList);
    const visible = data.filter((m) => !m.hidden);
    // Default first, like the picker in Codex itself.
    return [...visible.filter((m) => m.isDefault), ...visible.filter((m) => !m.isDefault)].map(
      (m) => ({
        id: m.model,
        name: m.displayName,
        description: m.description,
        autonomous: true,
      }),
    );
  }

  /** Live ChatGPT plan limits: the rolling window and the week. */
  async readLimits(): Promise<UsageWindow[] | undefined> {
    const response = await this.appServer(
      'account/rateLimits/read',
      undefined,
      RateLimitsResponse,
    ).catch(() => undefined);
    const snapshot = response?.rateLimits;
    if (!snapshot) return undefined;
    return [snapshot.primary, snapshot.secondary].flatMap((window) =>
      window?.resetsAt
        ? [
            {
              id: windowId(window.windowDurationMins),
              utilization: window.usedPercent / 100,
              resetsAt: new Date(window.resetsAt * 1000).toISOString(),
            },
          ]
        : [],
    );
  }

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    const prepared = await this.prepare(options);
    if (typeof prepared === 'string') {
      yield {
        type: 'finished',
        ok: false,
        output: prepared,
        sessionId: options.resumeSessionId ?? '',
        durationMs: 0,
        error: { kind: 'setup', message: prepared },
      };
      return;
    }
    const run = new AbortController();
    const forward = () => run.abort();
    options.signal?.addEventListener('abort', forward);
    const parser = new CodexStream(options.model);
    let hopeless: AgentError | undefined;

    const lines = spawnLines(this.bin, buildCodexArgs(options, prepared), {
      cwd: options.cwd,
      input: options.prompt,
      env: this.env(),
      signal: run.signal,
    });
    try {
      for await (const line of lines) {
        for (const event of parser.parse(line)) {
          // Codex retries a rejected key or an exhausted quota for a while; those
          // never succeed, so stop it and say why straight away.
          if (event.type === 'retry') {
            const error = classifyError(event.reason);
            if (isHopeless(error)) {
              hopeless = error;
              run.abort();
            }
          }
          yield event;
        }
      }
    } catch (error) {
      if (!parser.finished && !hopeless) throw error;
    } finally {
      options.signal?.removeEventListener('abort', forward);
    }
    if (hopeless && !parser.finished) {
      yield {
        type: 'finished',
        ok: false,
        output: hopeless.message,
        sessionId: parser.threadId,
        durationMs: 0,
        error: hopeless,
      };
      return;
    }
    if (!parser.finished) throw new Error('Codex exited without finishing its turn');
  }

  /** From `codex mcp list --json`. */
  async listMcpServers(cwd: string): Promise<{ name: string; status: string }[]> {
    const listed = await execCommand(this.bin, ['mcp', 'list', '--json'], this.env(), cwd);
    const parsed = McpList.safeParse(parseJson(listed?.stdout ?? ''));
    return parsed.success
      ? parsed.data.map((s) => ({ name: s.name, status: s.enabled ? 'Enabled' : 'Disabled' }))
      : [];
  }

  /**
   * Compact a conversation through Codex's app-server, as `/compact` does in
   * Codex's terminal: load the thread, ask for `thread/compact/start`, and wait
   * for that turn to finish.
   */
  async compact(sessionId: string, cwd: string, signal?: AbortSignal): Promise<Compacted> {
    const launch = resolveCommand(this.bin, ['app-server'], { env: this.env() });
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: this.env(),
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(launch.shell && { shell: true }),
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop);
    const timer = setTimeout(stop, COMPACT_TIMEOUT_MS);
    try {
      send({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'dazza', title: 'Dazza', version: pkg.version },
          capabilities: null,
        },
      });
      send({ method: 'initialized' });
      send({ method: 'thread/resume', id: 2, params: { threadId: sessionId } });
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const message = RpcMessage.safeParse(parseJson(line));
        if (!message.success) continue;
        const { id, method, error } = message.data;
        if (error) throw new Error(`Codex couldn’t compact the conversation: ${error.message}`);
        // Loaded: now compact it.
        if (id === 2)
          send({ method: 'thread/compact/start', id: 3, params: { threadId: sessionId } });
        if (method === 'turn/completed') return { type: 'compacted', trigger: 'manual' };
      }
      throw new Error('Codex stopped before it finished compacting the conversation.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      stop();
    }
  }

  /**
   * What to check before a run, and the extra flags it needs: returns what's
   * wrong, if anything, or the MCP servers of the user's to switch off.
   */
  private async prepare(options: AgentRunOptions): Promise<string | CodexExtras> {
    const [hooks, servers] = await Promise.all([
      options.guard ? this.checkHooks(options.cwd) : undefined,
      options.mcpServers ? this.otherMcpServers(options.cwd, options.mcpServers) : [],
    ]);
    if (hooks) return hooks;
    if (typeof servers === 'string') {
      // Only a problem if they're to be switched off; the chat keeps them.
      return options.userMcp ? {} : servers;
    }
    // The chat keeps the user's servers, pre-approved like Dazza's own; builders don't get them.
    return options.userMcp ? { approveMcpServers: servers } : { disableMcpServers: servers };
  }

  /**
   * Codex loads the MCP servers in the user's config (and a trusted project's)
   * into every session. Dazza's sessions get only Dazza's own, as on Claude Code
   * (--strict-mcp-config): the builder shouldn't reach the user's email or
   * databases through a server they set up for themselves.
   */
  private async otherMcpServers(
    cwd: string,
    ours: Record<string, unknown>,
  ): Promise<string[] | string> {
    const listed = await execCommand(this.bin, ['mcp', 'list', '--json'], this.env(), cwd);
    const parsed = McpList.safeParse(parseJson(listed?.stdout ?? ''));
    if (listed?.exitCode !== 0 || !parsed.success) {
      return 'Dazza couldn’t check which MCP servers Codex would load here, so it won’t run Codex. Update Codex (`codex update`) and try again.';
    }
    const others = parsed.data.filter((server) => server.enabled && !(server.name in ours));
    // Codex's -c splits keys on every dot, so only bare names can be switched off.
    const unaddressable = others.filter((server) => !/^[\w-]+$/.test(server.name));
    if (unaddressable.length > 0) {
      return (
        `Dazza can’t switch off your Codex MCP server ${unaddressable.map((s) => `"${s.name}"`).join(', ')} for its runs, ` +
        'because of how Codex reads the name. Rename it without dots, or set `enabled = false` for it in ~/.codex/config.toml.'
      );
    }
    return others.map((server) => server.name);
  }

  /**
   * Dazza's guard runs as a Codex hook, and Codex only runs hooks the user has
   * reviewed, so Dazza passes --dangerously-bypass-hook-trust. That flag would
   * also run hooks a repository brings in its own .codex folder, unreviewed.
   * Ask Codex which hooks it would load here, and refuse if any is the
   * repository's own and untrusted. Returns what's wrong, if anything.
   */
  private async checkHooks(cwd: string): Promise<string | undefined> {
    const listed = await this.appServer('hooks/list', { cwds: [cwd] }, HooksList, cwd).catch(
      () => undefined,
    );
    if (!listed) {
      return 'Dazza couldn’t check this project’s Codex hooks, so it won’t run Codex here. Update Codex (`codex update`) and try again.';
    }
    const unreviewed = listed.data
      .flatMap((entry) => entry.hooks)
      .filter(
        (hook) => hook.source === 'project' && hook.enabled && hook.trustStatus !== 'trusted',
      );
    if (unreviewed.length === 0) return undefined;
    const files = [...new Set(unreviewed.map((hook) => hook.sourcePath))].join(', ');
    return (
      `This project brings its own Codex hooks (${files}). They run commands on your machine, and ` +
      'Dazza won’t run them without your say-so. If you trust them, open `codex` in this folder and approve them with /hooks, then try again. Otherwise remove them.'
    );
  }

  /**
   * One request to Codex's app-server: start it, introduce ourselves, ask, and
   * shut it down. Takes a second or two and never touches the model.
   */
  private async appServer<T>(
    method: string,
    params: object | undefined,
    result: z.ZodType<T>,
    cwd = process.cwd(),
  ): Promise<T> {
    const messages = [
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'dazza', title: 'Dazza', version: pkg.version },
          capabilities: null,
        },
      },
      { method: 'initialized' },
      { method, id: 2, ...(params !== undefined && { params }) },
    ];
    const controller = new AbortController();
    const lines = spawnLines(this.bin, ['app-server'], {
      cwd,
      // stdin stays open until we've read the answer, then we stop the server.
      input: `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`,
      keepStdinOpen: true,
      env: this.env(),
      signal: controller.signal,
    });
    try {
      for await (const line of lines) {
        const reply = RpcReply.safeParse(parseJson(line));
        if (!reply.success || reply.data.id !== 2) continue;
        if (reply.data.error) throw new Error(reply.data.error.message);
        return result.parse(reply.data.result);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      controller.abort();
    }
    throw new Error(`Codex didn’t answer ${method}`);
  }
}

/** Codex lets a call through if its hook times out, so allow the guard plenty. */
const GUARD_TIMEOUT_SECONDS = 60;

/**
 * Command-line flags for `codex exec`. The prompt goes on stdin ("-"). Building
 * runs in a workspace-write sandbox with network access and automatic approval
 * review (Codex's equivalent of Claude Code's auto mode); conversations run
 * read-only. Dazza's MCP tools are pre-approved.
 */
export interface CodexExtras {
  /** MCP servers from the user's config to switch off for this run. */
  disableMcpServers?: string[];
  /** The user's own MCP servers, kept and pre-approved (for the chat). */
  approveMcpServers?: string[];
}

export function buildCodexArgs(
  options: Omit<AgentRunOptions, 'prompt'>,
  { disableMcpServers = [], approveMcpServers = [] }: CodexExtras = {},
): string[] {
  // Live web search: Codex's default is a cached index, too stale for prices and versions.
  const args = ['exec', '--json', '--skip-git-repo-check', '-c', 'web_search="live"'];
  if (options.model) args.push('-m', options.model);
  if (options.autonomous) {
    // --approve-for-me implies the workspace-write sandbox (and Codex rejects an
    // explicit --sandbox alongside it); network access is switched on separately.
    args.push('--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true');
  } else {
    args.push('-s', 'read-only', '-c', 'approval_policy="never"');
  }
  if (options.systemPrompt) args.push('-c', `developer_instructions=${toml(options.systemPrompt)}`);
  if (options.guard) {
    // Dazza's guard checks every tool call first (see src/guard). Codex runs only
    // hooks the user has reviewed; this one is Dazza's own, passed here and not
    // from any file, and CodexProvider.run refuses repositories with hooks of their own.
    const hook = shellCommand(options.guard.command, options.guard.args);
    args.push(
      '--dangerously-bypass-hook-trust',
      '-c',
      `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${toml(hook)},timeout=${GUARD_TIMEOUT_SECONDS}}]}]`,
    );
  }
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    args.push(
      '-c',
      `mcp_servers.${name}.command=${toml(server.command)}`,
      '-c',
      `mcp_servers.${name}.args=${toml(server.args)}`,
      '-c',
      `mcp_servers.${name}.default_tools_approval_mode="approve"`,
    );
  }
  for (const name of disableMcpServers) args.push('-c', `mcp_servers.${name}.enabled=false`);
  for (const name of approveMcpServers) {
    args.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
  }
  if (options.resumeSessionId) args.push('resume', options.resumeSessionId);
  args.push('-');
  return args;
}

/**
 * Turns `codex exec --json` lines into Dazza events. Stateful: remembers the
 * thread id and whether the turn finished, and maps Codex's items (commands,
 * file changes, MCP calls) onto the same tool events Claude produces, so the
 * rest of Dazza doesn't care which agent is running.
 */
export class CodexStream {
  threadId = '';
  finished = false;
  private readonly startedAt = Date.now();

  private lastText = '';

  constructor(private readonly model: string | undefined) {}

  parse(line: string): AgentEvent[] {
    const parsed = CodexLine.safeParse(parseJson(line));
    if (!parsed.success) return [];
    const event = parsed.data;
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.thread_id;
        return [
          { type: 'started', sessionId: event.thread_id, model: this.model ?? 'Codex default' },
        ];
      case 'error': {
        const retry = /^Reconnecting\.\.\. (\d+)\/(\d+) \((.*)\)$/s.exec(event.message);
        return retry
          ? [
              {
                type: 'retry',
                attempt: Number(retry[1]),
                maxRetries: Number(retry[2]),
                reason: retry[3] ?? '',
              },
            ]
          : [];
      }
      case 'item.started':
        return itemStarted(event.item);
      case 'item.completed': {
        const events = itemCompleted(event.item);
        // Like Claude Code's result: the agent's last words, e.g. why it stopped.
        for (const e of events) if (e.type === 'text') this.lastText = e.text;
        return events;
      }
      case 'turn.completed':
        this.finished = true;
        return [
          {
            type: 'finished',
            ok: true,
            output: this.lastText,
            sessionId: this.threadId,
            durationMs: Date.now() - this.startedAt,
            usage: {
              tokens: event.usage.input_tokens + event.usage.output_tokens,
              // Codex doesn't report prices; a ChatGPT plan has none per run.
              costUsd: 0,
            },
          },
        ];
      case 'turn.failed':
        this.finished = true;
        return [
          {
            type: 'finished',
            ok: false,
            output: event.error.message,
            sessionId: this.threadId,
            durationMs: Date.now() - this.startedAt,
            error: classifyError(event.error.message),
          },
        ];
    }
  }
}

/** Calls are announced when they start, so the CLI can show them live. */
function itemStarted(item: CodexItem): AgentEvent[] {
  switch (item.type) {
    case 'command_execution':
      return [
        {
          type: 'tool_use',
          id: item.id,
          tool: 'Bash',
          input: { command: unwrapShell(item.command) },
        },
      ];
    case 'mcp_tool_call':
      return [
        {
          type: 'tool_use',
          id: item.id,
          tool: `mcp__${item.server}__${item.tool}`,
          input: item.arguments ?? {},
        },
      ];
    default:
      return [];
  }
}

function itemCompleted(item: CodexItem): AgentEvent[] {
  switch (item.type) {
    case 'agent_message':
      return item.text.trim() ? [{ type: 'text', text: item.text }] : [];
    case 'command_execution':
      return [{ type: 'tool_result', id: item.id, ok: item.exit_code === 0 }];
    case 'mcp_tool_call':
      return [{ type: 'tool_result', id: item.id, ok: item.status === 'completed' && !item.error }];
    case 'file_change':
      // Codex reports edits once applied, without the text; show which files changed.
      return item.changes.map((change, i) => ({
        type: 'tool_use' as const,
        id: `${item.id}-${i}`,
        tool: change.kind === 'add' ? 'Write' : change.kind === 'delete' ? 'Delete' : 'Edit',
        input: { file_path: change.path },
      }));
    case 'web_search':
      return [{ type: 'tool_use', id: item.id, tool: 'WebSearch', input: { query: item.query } }];
    // Codex summarised the conversation by itself, having run low on room.
    case 'context_compaction':
      return [{ type: 'compacted', trigger: 'auto' }];
    default:
      return [];
  }
}

// Only the fields Dazza reads. Anything else in the stream is ignored.
const CodexItem = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('agent_message'), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('command_execution'),
    command: z.string(),
    exit_code: z.number().nullish(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('file_change'),
    changes: z.array(z.object({ path: z.string(), kind: z.string() })),
  }),
  z.object({
    id: z.string(),
    type: z.literal('mcp_tool_call'),
    server: z.string(),
    tool: z.string(),
    arguments: z.unknown().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
  }),
  z.object({ id: z.string(), type: z.literal('web_search'), query: z.string() }),
  z.object({ id: z.string(), type: z.literal('context_compaction') }),
  z.object({ id: z.string(), type: z.enum(['reasoning', 'todo_list', 'error']) }),
]);
type CodexItem = z.infer<typeof CodexItem>;

const CodexLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('item.started'), item: CodexItem }),
  z.object({ type: z.literal('item.completed'), item: CodexItem }),
  z.object({
    type: z.literal('turn.completed'),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** How long a compaction may take: it's a model call, summarising the conversation. */
const COMPACT_TIMEOUT_MS = 5 * 60_000;

/** Replies and notifications from the app-server. */
const RpcMessage = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const RpcReply = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const AccountResponse = z.object({
  account: z
    .union([
      z.object({ type: z.literal('chatgpt'), planType: z.string().nullish() }),
      z.object({ type: z.string() }),
    ])
    .nullable(),
});

const ModelList = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      description: z.string(),
      hidden: z.boolean().default(false),
      isDefault: z.boolean().default(false),
    }),
  ),
});

const McpList = z.array(z.object({ name: z.string(), enabled: z.boolean().default(true) }));

const HooksList = z.object({
  data: z.array(
    z.object({
      hooks: z.array(
        z.object({
          source: z.string(),
          sourcePath: z.string(),
          enabled: z.boolean().default(true),
          trustStatus: z.string(),
        }),
      ),
    }),
  ),
});

const RateWindow = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .nullable();

const RateLimitsResponse = z.object({
  rateLimits: z.object({ primary: RateWindow, secondary: RateWindow }).nullable(),
});

/** Codex runs commands through a login shell; show the command itself. */
export function unwrapShell(command: string): string {
  const wrapped = /^(?:\/\S+\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  return wrapped?.[1] ? wrapped[1].replace(/'\\''/g, "'") : command;
}

/** Name a limit window the way Dazza shows it. */
function windowId(minutes: number | null): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 7 * 24 * 60) return 'seven_day';
  return minutes ? `${minutes}m` : 'window';
}

/** A value as TOML, for Codex's -c overrides. JSON strings and arrays are valid TOML. */
function toml(value: string | string[]): string {
  return JSON.stringify(value);
}
