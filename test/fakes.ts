import type {
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
  ModelOption,
} from '../src/providers/types.js';

/** An in-memory provider: records runs and replays canned events. */
export class FakeProvider implements AgentProvider {
  /** Compaction, as the provider reports it; tests set what comes back. */
  compacted: { before?: number; after?: number } = { before: 50_000, after: 2_000 };
  compactions: string[] = [];

  mcpServers = [{ name: 'claude.ai Gmail', status: 'Connected' }];

  async listMcpServers() {
    return this.mcpServers;
  }

  async compact(sessionId: string) {
    this.compactions.push(sessionId);
    return { type: 'compacted' as const, trigger: 'manual' as const, ...this.compacted };
  }

  readonly id = 'claude';
  readonly name = 'Fake';
  readonly runs: AgentRunOptions[] = [];

  constructor(
    readonly events: AgentEvent[] = [
      { type: 'started', sessionId: 'session-1', model: 'fake' },
      { type: 'text', text: 'What are we building?' },
      { type: 'finished', ok: true, output: '', sessionId: 'session-1', durationMs: 1 },
    ],
    readonly models: ModelOption[] = [
      { id: 'default', name: 'Default', description: 'Recommended', autonomous: true },
      { id: 'sonnet', name: 'Sonnet', description: 'Fast', autonomous: true },
    ],
  ) {}

  async detect() {
    return {
      installed: true as const,
      version: '1.0.0',
      loggedIn: true,
      plan: 'Claude Max',
    };
  }

  /** Side effects to perform during a run, e.g. acting like a worker that edits and submits. */
  onRun: ((options: AgentRunOptions) => Promise<void>) | undefined;

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    this.runs.push(options);
    await this.onRun?.(options);
    if (options.signal?.aborted) throw new Error('aborted');
    yield* this.events;
  }

  async listModels() {
    return this.models;
  }

  async signIn() {}
}
