import { z } from 'zod';
import type { Connection } from '../core/config.js';
import { execCommand, runInteractive, spawnLines } from '../util/process.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
  ModelOption,
  ProviderStatus,
  RunUsage,
} from './types.js';

/**
 * Drives the user's installed `claude` CLI in headless mode, so authentication
 * (subscription or API key) is whatever the user already set up for Claude Code.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private readonly bin: string;
  private readonly connection: Connection | undefined;

  constructor(options: { bin?: string; connection?: Connection } = {}) {
    this.bin = options.bin ?? 'claude';
    this.connection = options.connection;
  }

  /**
   * The environment Claude Code runs with. With an API key, Dazza passes it in;
   * on a subscription, a stray ANTHROPIC_API_KEY in the user's shell is removed
   * so it can't quietly switch them to pay-as-you-go billing.
   */
  private env(): NodeJS.ProcessEnv {
    const { ANTHROPIC_API_KEY: _, ...env } = process.env;
    return this.connection?.method === 'api-key'
      ? { ...env, ANTHROPIC_API_KEY: this.connection.apiKey }
      : env;
  }

  /** Hand the terminal to `claude auth login` so the user can sign in. */
  async signIn(): Promise<void> {
    await runInteractive(this.bin, ['auth', 'login']);
  }

  async detect(): Promise<ProviderStatus> {
    const version = await execCommand(this.bin, ['--version']);
    if (version === undefined || version.exitCode !== 0) return { installed: false };

    const auth = AuthStatus.safeParse(
      parseJson((await execCommand(this.bin, ['auth', 'status'], this.env()))?.stdout),
    );
    const plan = auth.success ? auth.data.subscriptionType : undefined;
    return {
      installed: true,
      version: version.stdout.trim().split(' ')[0] ?? 'unknown',
      loggedIn: auth.success && auth.data.loggedIn,
      ...(auth.success && auth.data.authMethod && { authMethod: auth.data.authMethod }),
      ...(plan && { plan: `Claude ${capitalize(plan)}` }),
    };
  }

  /**
   * Ask the CLI which models this account can use. This is the control protocol
   * the Claude Agent SDK uses for the same purpose; no prompt is sent, so it's free.
   */
  async listModels(): Promise<ModelOption[]> {
    const request = {
      type: 'control_request',
      request_id: 'models',
      request: { subtype: 'initialize' },
    };
    const lines = spawnLines(
      this.bin,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: process.cwd(), input: `${JSON.stringify(request)}\n`, env: this.env() },
    );
    for await (const line of lines) {
      const parsed = InitializeResponse.safeParse(parseJson(line));
      if (parsed.success) {
        return parsed.data.response.response.models.map((m) => ({
          id: m.value,
          name: m.displayName,
          description: m.description,
          autonomous: m.supportsAutoMode ?? false,
        }));
      }
    }
    throw new Error('Claude Code did not report its models');
  }

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    let finished = false;
    // The stream can repeat a tool call across messages; report each one once.
    const seenTools = new Set<string>();
    const lines = spawnLines(this.bin, buildClaudeArgs(options), {
      cwd: options.cwd,
      input: options.prompt,
      env: this.env(),
      ...(options.signal && { signal: options.signal }),
    });
    for await (const line of lines) {
      for (const event of parseClaudeLine(line)) {
        if (event.type === 'finished') finished = true;
        if (event.type === 'tool_use') {
          if (seenTools.has(event.id)) continue;
          seenTools.add(event.id);
        }
        yield event;
      }
    }
    if (!finished) throw new Error('Claude Code exited without reporting a result');
  }
}

/** CLI flags for a headless run. The prompt itself is sent on stdin, never as an argument. */
export function buildClaudeArgs(options: Omit<AgentRunOptions, 'prompt'>): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
  if (options.mcpServers) {
    // Strict: the agent gets exactly the servers Dazza hands it, not the user's personal ones.
    args.push(
      '--mcp-config',
      JSON.stringify({ mcpServers: options.mcpServers }),
      '--strict-mcp-config',
    );
  }
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  // Auto mode: edits and commands go ahead, Claude Code's safety classifier blocks risky ones.
  if (options.autonomous) args.push('--permission-mode', 'auto');
  return args;
}

/**
 * Translate one line of `--output-format stream-json` into Dazza events.
 * Unknown or irrelevant lines yield nothing, so new CLI event types never break us.
 */
export function parseClaudeLine(line: string): AgentEvent[] {
  const parsed = StreamLine.safeParse(parseJson(line));
  if (!parsed.success) return [];

  const message = parsed.data;
  switch (message.type) {
    case 'system':
      return [{ type: 'started', sessionId: message.session_id, model: message.model }];
    case 'assistant':
      return message.message.content.flatMap(toContentEvent);
    case 'user':
      return message.message.content.flatMap(toToolResult);
    case 'rate_limit_event':
      return [
        {
          type: 'limits',
          windows: Object.entries(message.rate_limit_info.unifiedWindows).map(([id, w]) => ({
            id,
            utilization: w.utilization,
            resetsAt: new Date(w.resetsAt * 1000).toISOString(),
          })),
        },
      ];
    case 'result':
      return [
        {
          type: 'finished',
          ok: message.subtype === 'success' && !message.is_error,
          output: message.result ?? '',
          sessionId: message.session_id,
          durationMs: message.duration_ms,
          ...(message.usage && { usage: toRunUsage(message.usage, message.total_cost_usd) }),
        },
      ];
  }
}

function toContentEvent(block: unknown): AgentEvent[] {
  const parsed = ContentBlock.safeParse(block);
  if (!parsed.success) return [];
  return parsed.data.type === 'text'
    ? [{ type: 'text', text: parsed.data.text }]
    : [{ type: 'tool_use', id: parsed.data.id, tool: parsed.data.name, input: parsed.data.input }];
}

function toToolResult(block: unknown): AgentEvent[] {
  const parsed = ToolResultBlock.safeParse(block);
  return parsed.success
    ? [{ type: 'tool_result', id: parsed.data.tool_use_id, ok: parsed.data.is_error !== true }]
    : [];
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Only the fields Dazza reads. Everything else in the stream is ignored.
const StreamLine = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('assistant'),
    message: z.object({ content: z.array(z.unknown()) }),
  }),
  z.object({
    type: z.literal('user'),
    message: z.object({
      content: z
        .union([z.array(z.unknown()), z.string()])
        .transform((c) => (typeof c === 'string' ? [] : c)),
    }),
  }),
  z.object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string(),
    duration_ms: z.number(),
    total_cost_usd: z.number().default(0),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: z.object({
      unifiedWindows: z.record(
        z.string(),
        z.object({ utilization: z.number(), resetsAt: z.number() }),
      ),
    }),
  }),
]);

const InitializeResponse = z.object({
  type: z.literal('control_response'),
  response: z.object({
    response: z.object({
      models: z.array(
        z.object({
          value: z.string(),
          displayName: z.string(),
          description: z.string(),
          supportsAutoMode: z.boolean().optional(),
        }),
      ),
    }),
  }),
});

const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});

const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
]);

const AuthStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  subscriptionType: z.string().optional(),
});

/** Every token the run consumed, cache reads and writes included. */
function toRunUsage(usage: Record<string, unknown>, costUsd: number): RunUsage {
  const count = (key: string) => (typeof usage[key] === 'number' ? usage[key] : 0);
  return {
    tokens:
      count('input_tokens') +
      count('output_tokens') +
      count('cache_read_input_tokens') +
      count('cache_creation_input_tokens'),
    costUsd,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
