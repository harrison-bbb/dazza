import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  type CommandContext,
  complete,
  helpText,
  parseCommand,
  pickModel,
  suggest,
  usageReport,
} from '../../src/chat/commands.js';
import { FakeProvider } from '../fakes.js';
import { useTempProject } from '../helpers.js';

const models = [
  { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
  { id: 'opus', name: 'Opus 5.5', description: 'Most capable' },
  { id: 'sonnet', name: 'Sonnet 5', description: 'Everyday' },
];

describe('parsing and completion', () => {
  it('finds commands by name or alias, with arguments', () => {
    expect(parseCommand('/model sonnet')).toMatchObject({
      command: { name: 'model' },
      args: 'sonnet',
    });
    expect(parseCommand('/board').command?.name).toBe('dashboard');
    expect(parseCommand('/nope').command).toBeUndefined();
  });

  it('suggests a close command', () => {
    expect(suggest('mdl')).toBeUndefined();
    expect(suggest('mod')?.name).toBe('model');
  });

  it('completes command names', () => {
    expect(complete('/da')).toEqual([['/dashboard'], '/da']);
    expect(complete('hello')).toEqual([[], 'hello']);
  });

  it('lists every command in /help', () => {
    for (const command of COMMANDS) expect(helpText()).toContain(`/${command.name}`);
  });
});

describe('pickModel', () => {
  it('matches by number, id or name', () => {
    expect(pickModel(models, '3')?.id).toBe('sonnet');
    expect(pickModel(models, 'opus')?.id).toBe('opus');
    expect(pickModel(models, 'Sonnet 5')?.id).toBe('sonnet');
    expect(pickModel(models, 'son')?.id).toBe('sonnet');
    expect(pickModel(models, '9')).toBeUndefined();
    expect(pickModel(models, 'gpt')).toBeUndefined();
  });
});

describe('usageReport', () => {
  const now = new Date('2026-09-27T10:00:00Z');

  it('shows limit windows and project totals', () => {
    const report = usageReport(
      'Claude Max',
      {
        checkedAt: '2026-09-27T09:55:00Z',
        windows: [{ id: 'five_hour', utilization: 0.25, resetsAt: '2026-09-27T12:00:00Z' }],
      },
      { runs: 12, tokens: 1_400_000, costUsd: 3.2 },
      now,
    );
    expect(report).toContain('Claude Max');
    expect(report).toContain('5-hour limit');
    expect(report).toContain('25%');
    expect(report).toContain('5 min ago');
    expect(report).toContain('12 messages · 1.4M tokens · $3.20 at API prices');
  });

  it('says when there is no reading yet', () => {
    const report = usageReport('Claude Pro', undefined, { runs: 1, tokens: 10, costUsd: 0 }, now);
    expect(report).toContain('No limit reading yet');
    expect(report).toContain('1 message ·');
  });
});

describe('running commands', () => {
  const project = useTempProject();

  const context = () => {
    const said: string[] = [];
    const provider = new FakeProvider(undefined, models);
    let exited = false;
    const ctx: CommandContext = {
      store: project.store,
      config: project.config,
      provider,
      boardUrl: 'http://localhost:4777',
      say: (text) => said.push(text),
      exit: () => {
        exited = true;
      },
    };
    return { ctx, said, provider, exited: () => exited };
  };
  const run = (ctx: CommandContext, line: string) => {
    const { command, args } = parseCommand(line);
    if (!command) throw new Error(`no command for ${line}`);
    return command.run(ctx, args);
  };

  it('/model lists models, marks the current one, and switches', async () => {
    const { ctx, said } = context();
    await run(ctx, '/model');
    expect(said[0]).toContain('Default (recommended)');

    await run(ctx, '/model sonnet');
    expect(await project.config.readSettings()).toEqual({ model: 'sonnet' });
    expect(said[1]).toContain('Switched to');

    await run(ctx, '/model gpt');
    expect(said[2]).toContain('No model matches');
    expect(await project.config.readSettings()).toEqual({ model: 'sonnet' });
  });

  it('/logout needs confirming, then signs out and exits', async () => {
    const { ctx, said, provider, exited } = context();
    await run(ctx, '/logout');
    expect(provider.loggedOut).toBe(false);
    expect(said[0]).toContain('not just Dazza');

    await run(ctx, '/logout confirm');
    expect(provider.loggedOut).toBe(true);
    expect(exited()).toBe(true);
  });

  it('/exit ends the chat', async () => {
    const { ctx, exited } = context();
    await run(ctx, '/quit');
    expect(exited()).toBe(true);
  });
});
