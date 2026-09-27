import type {
  AgentEvent,
  AgentProvider,
  AgentRunOptions,
  ModelOption,
} from '../src/providers/types.js';

/** An in-memory provider: records runs and replays canned events. */
export class FakeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Fake';
  readonly runs: AgentRunOptions[] = [];

  constructor(
    private readonly events: AgentEvent[] = [
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
