/** A coding agent CLI that Dazza drives headlessly (Claude Code, Codex, ...). */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
}

export type ProviderId = 'claude' | 'codex';

export type ProviderStatus =
  | { installed: false }
  | { installed: true; version: string; loggedIn: boolean; authMethod?: string };

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  /** Continue an earlier session instead of starting fresh. */
  resumeSessionId?: string;
  /** Extra instructions appended to the agent's own system prompt. */
  systemPrompt?: string;
  model?: string;
  signal?: AbortSignal;
}

/** Provider-neutral view of what the agent is doing. Every run ends with `finished`. */
export type AgentEvent =
  | { type: 'started'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'finished'; ok: boolean; output: string; sessionId: string; durationMs: number };
