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
      { id: 'default', name: 'Default', description: 'Recommended' },
      { id: 'sonnet', name: 'Sonnet', description: 'Fast' },
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

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent> {
    this.runs.push(options);
    yield* this.events;
  }

  async listModels() {
    return this.models;
  }
}
