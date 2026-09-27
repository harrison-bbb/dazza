/** A coding agent CLI that Dazza drives headlessly (Claude Code, Codex, ...). */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Models this account can use, as the provider lists them. Must not spend tokens. */
  listModels(): Promise<ModelOption[]>;
  /** Sign out of the provider's own CLI, which affects it everywhere, not just in Dazza. */
  logout(): Promise<void>;
}

export interface ModelOption {
  /** What to pass as `model` when running. */
  id: string;
  name: string;
  description: string;
}

export type ProviderId = 'claude' | 'codex';

export type ProviderStatus =
  | { installed: false }
  | {
      installed: true;
      version: string;
      loggedIn: boolean;
      authMethod?: string;
      /** Subscription plan, e.g. "Claude Max", when signed in with one. */
      plan?: string;
    };

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  /** Continue an earlier session instead of starting fresh. */
  resumeSessionId?: string;
  /** Extra instructions appended to the agent's own system prompt. */
  systemPrompt?: string;
  model?: string;
  /** Tools the agent may use without asking. Anything else needing permission is denied. */
  allowedTools?: string[];
  /** The only MCP servers the session may use, keyed by server name. */
  mcpServers?: Record<string, McpServerConfig>;
  signal?: AbortSignal;
}

export interface McpServerConfig {
  command: string;
  args: string[];
}

/** Provider-neutral view of what the agent is doing. Every run ends with `finished`. */
export type AgentEvent =
  | { type: 'started'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'limits'; windows: UsageWindow[] }
  | {
      type: 'finished';
      ok: boolean;
      output: string;
      sessionId: string;
      durationMs: number;
      usage?: RunUsage;
    };

/** A subscription rate-limit window, e.g. the rolling five hours or the week. */
export interface UsageWindow {
  id: string;
  /** 0 to 1. */
  utilization: number;
  resetsAt: string;
}

export interface RunUsage {
  tokens: number;
  /** What the run would cost at API prices, even on a subscription. */
  costUsd: number;
}
