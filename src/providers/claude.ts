import { z } from 'zod';
import { execCommand, spawnLines } from '../util/process.js';
import type { AgentEvent, AgentProvider, AgentRunOptions, ProviderStatus } from './types.js';

/**
 * Drives the user's installed `claude` CLI in headless mode, so authentication
 * (subscription or API key) is whatever the user already set up for Claude Code.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  constructor(private readonly bin = 'claude') {}

  async detect(): Promise<ProviderStatus> {
    const version = await execCommand(this.bin, ['--version']);
    if (version === undefined || version.exitCode !== 0) return { installed: false };

    const auth = AuthStatus.safeParse(
      parseJson((await execCommand(this.bin, ['auth', 'status']))?.stdout),
    );
    return {
      installed: true,
      version: version.stdout.trim().split(' ')[0] ?? 'unknown',
      loggedIn: auth.success && auth.data.loggedIn,
      ...(auth.success && auth.data.authMethod && { authMethod: auth.data.authMethod }),
    };
  }

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    let finished = false;
    const lines = spawnLines(this.bin, buildClaudeArgs(options), {
      cwd: options.cwd,
      input: options.prompt,
      ...(options.signal && { signal: options.signal }),
    });
    for await (const line of lines) {
      for (const event of parseClaudeLine(line)) {
        if (event.type === 'finished') finished = true;
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
    case 'result':
      return [
        {
          type: 'finished',
          ok: message.subtype === 'success' && !message.is_error,
          output: message.result ?? '',
          sessionId: message.session_id,
          durationMs: message.duration_ms,
        },
      ];
  }
}

function toContentEvent(block: unknown): AgentEvent[] {
  const parsed = ContentBlock.safeParse(block);
  if (!parsed.success) return [];
  return parsed.data.type === 'text'
    ? [{ type: 'text', text: parsed.data.text }]
    : [{ type: 'tool_use', tool: parsed.data.name, input: parsed.data.input }];
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
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string(),
    duration_ms: z.number(),
  }),
]);

const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown() }),
]);

const AuthStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
});
