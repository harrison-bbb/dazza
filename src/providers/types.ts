/** A coding agent CLI that Dazza drives headlessly (Claude Code, Codex, ...). */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Models this account can use, as the provider lists them. Must not spend tokens. */
  listModels(): Promise<ModelOption[]>;
  /**
   * Current subscription limits, read live without spending tokens, when the
   * provider can (Codex can; Claude Code only reports them during a run).
   */
  readLimits?(): Promise<UsageWindow[] | undefined>;
  /** The MCP servers the user has set up in the CLI itself, with how each is doing. */
  listMcpServers(cwd: string): Promise<{ name: string; status: string }[]>;
  /** Hand the terminal to the CLI's own sign-in. */
  signIn(): Promise<void>;
  /**
   * Compact a conversation with the CLI's own compaction, as `/compact` does in
   * its terminal: summarised, so it takes less room and costs less per turn.
   */
  compact(sessionId: string, cwd: string, signal?: AbortSignal): Promise<Compacted>;
}

export type Compacted = Extract<AgentEvent, { type: 'compacted' }>;

export interface ModelOption {
  /** What to pass as `model` when running. */
  id: string;
  name: string;
  description: string;
  /** Whether the model can run autonomously (needed to build). */
  autonomous: boolean;
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
  /**
   * The agent CLI's own built-in tools the session has at all (Claude Code's
   * --tools). Every tool it has is described in every request, so fewer is
   * cheaper. Leave out for the CLI's full set.
   */
  tools?: string[];
  /** Dazza's MCP servers for the session, keyed by server name. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Also the MCP servers the user has set up in the agent CLI itself. Otherwise
   * the session gets Dazza's alone.
   */
  userMcp?: boolean;
  /**
   * Let the agent edit files and run commands without asking, with the
   * provider's own safety checks blocking risky actions.
   */
  autonomous?: boolean;
  /**
   * A command to check every tool call before it runs (Dazza's guard), where
   * the agent CLI supports it. It reads the call as JSON on stdin.
   */
  guard?: McpServerConfig;
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
  | { type: 'tool_use'; id: string; tool: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean }
  /**
   * The conversation was compacted: summarised to free up room, asked for
   * (manual) or because it was getting full (auto). Sizes in tokens, when known.
   */
  | { type: 'compacted'; trigger: 'manual' | 'auto'; before?: number; after?: number }
  /** The CLI is retrying a failed API call itself. */
  | { type: 'retry'; attempt: number; maxRetries: number; reason: string }
  | {
      type: 'limits';
      windows: UsageWindow[];
      /** Set when the account is currently being refused for hitting a limit. */
      limitedUntil?: string;
    }
  | {
      type: 'finished';
      ok: boolean;
      output: string;
      sessionId: string;
      durationMs: number;
      usage?: RunUsage;
      /** Why the run failed, when it did. */
      error?: AgentError;
    };

/**
 * Why a run failed, in terms Dazza can act on: wait for a limit to reset, ask
 * the user to top up or reconnect, retry a busy service, or give up.
 */
export type AgentError =
  | { kind: 'usage_limit'; message: string; resetsAt?: string }
  | { kind: 'credits'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'overloaded'; message: string }
  /** Something about this machine or project stops the agent running here at all. */
  | { kind: 'setup'; message: string }
  | { kind: 'failed'; message: string };

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
