import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  type CommandContext,
  commandMenu,
  helpText,
  limitsReport,
  parseCommand,
  pickModel,
  spendReport,
  suggest,
} from '../../src/chat/commands.js';
import { FakeProvider } from '../fakes.js';
import { useTempProject } from '../helpers.js';

const models = [
  { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', autonomous: true },
  { id: 'opus', name: 'Opus 5.5', description: 'Most capable', autonomous: true },
  { id: 'sonnet', name: 'Sonnet 5', description: 'Everyday', autonomous: true },
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

  it('builds the live menu from commands and aliases', () => {
    expect(commandMenu('/').length).toBe(COMMANDS.length);
    expect(commandMenu('/bo').map((m) => m.value)).toEqual(['/dashboard']);
    expect(commandMenu('/model 2')).toEqual([]);
    expect(commandMenu('hello')).toEqual([]);
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

describe('usage reports', () => {
  const now = new Date('2026-09-27T10:00:00Z');

  it('shows subscription windows like Claude Code', () => {
    const report = limitsReport(
      'Claude Max',
      {
        checkedAt: '2026-09-27T09:55:00Z',
        windows: [
          { id: 'five_hour', utilization: 0.25, resetsAt: '2026-09-27T12:00:00Z' },
          { id: 'seven_day', utilization: 0.1, resetsAt: '2026-10-01T00:00:00Z' },
        ],
      },
      now,
    );
    expect(report).toContain('Current session');
    expect(report).toContain('25% used');
    expect(report).toContain('Current week');
    expect(report).toContain('██████████'); // 25% of a 40-wide bar
    expect(report).toContain('Resets');
    expect(report).toContain('5 min ago');
  });

  it('says when there is no reading yet', () => {
    expect(limitsReport('Claude Pro', undefined, now)).toContain('No reading yet');
  });

  it('shows API spend in dollars with a billing link', () => {
    const report = spendReport(
      { runs: 1, tokens: 12_000, costUsd: 0.42 },
      { runs: 12, tokens: 1_400_000, costUsd: 3.2 },
    );
    expect(report).toContain('$0.42');
    expect(report).toContain('1 message ·');
    expect(report).toContain('$3.20');
    expect(report).toContain('console.anthropic.com/settings/billing');
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
      connection: { provider: 'claude', method: 'subscription' },
      session: { runs: 0, tokens: 0, costUsd: 0 },
      boardUrl: 'http://localhost:4777',
      startBuild: async () => {},
      status: () => {},
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

  it('/logout signs out of Dazza only, then exits', async () => {
    const { ctx, said, exited } = context();
    await project.config.writeConnection({ provider: 'claude', method: 'subscription' });
    await run(ctx, '/logout');
    expect(await project.config.readConnection()).toBeUndefined();
    expect(said[0]).toContain('Signed out of Dazza');
    expect(exited()).toBe(true);
  });

  it('/usage picks the report for the connection', async () => {
    const { ctx, said } = context();
    await run(
      { ...ctx, connection: { provider: 'claude', method: 'api-key', apiKey: 'k' } },
      '/usage',
    );
    expect(said[0]).toContain('pay as you go');
    await run(ctx, '/usage');
    expect(said[1]).toContain('Claude Max');
  });

  it('/exit ends the chat', async () => {
    const { ctx, exited } = context();
    await run(ctx, '/quit');
    expect(exited()).toBe(true);
  });
});
