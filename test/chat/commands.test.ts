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
import { stripAnsi } from '../../src/chat/style.js';
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

  it('lists every command in /help, grouped, with the -disconnect ones mentioned by their parent', () => {
    const help = stripAnsi(helpText());
    for (const command of COMMANDS) expect(help).toContain(`/${command.name}`);
    expect(help.indexOf('The work')).toBeLessThan(help.indexOf('Reviewing'));
    expect(help.indexOf('/build')).toBeLessThan(help.indexOf('/review'));
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
      { now },
    );
    expect(report).toContain('Current session');
    expect(report).toContain('25% used');
    expect(report).toContain('Current week');
    expect(report).toContain('██████████'); // 25% of a 40-wide bar
    expect(report).toContain('Resets');
    expect(report).toContain('5 min ago');
  });

  it('says when there is no reading yet', () => {
    expect(limitsReport('Claude Pro', undefined, { now })).toContain('No reading yet');
  });

  it('shows API spend in dollars with a billing link', () => {
    const report = spendReport(
      'claude',
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
    const linked: string[] = [];
    const confirmAnswer = true;
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
      requestReport: async () => {},
      stopBuild: async () => {},
      building: () => false,
      chatting: () => false,
      context: () => ({ tokens: 150_000, window: 200_000 }),
      resetContext: () => {},
      compact: async () => 'Compacted our conversation (50k → 2k tokens).',
      reconnect: async () => {},
      confirm: async () => confirmAnswer,
      status: () => {},
      link: async (channel) => {
        linked.push(channel);
      },
      unlink: async (channel) => {
        if (channel === 'telegram') await project.config.clearTelegram();
        else await project.config.clearSlack();
      },
      say: (text) => said.push(text),
      exit: () => {
        exited = true;
      },
    };
    return { ctx, said, provider, exited: () => exited, linked: () => linked };
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

  it('/telegram links when unlinked, and reports the link otherwise', async () => {
    const { ctx, said, linked } = context();
    await run(ctx, '/telegram');
    expect(linked()).toEqual(['telegram']);

    await project.config.writeTelegram({ botToken: 't', botUsername: 'dazza_bot', chatId: '1' });
    await run(ctx, '/telegram');
    expect(said.at(-1)).toContain('Connected to @dazza_bot');
    expect(linked()).toEqual(['telegram']);
  });

  it('/telegram-disconnect just unlinks', async () => {
    const { ctx, said, linked } = context();
    await project.config.writeTelegram({ botToken: 't', botUsername: 'old_bot', chatId: '1' });
    await run(ctx, '/telegram-disconnect');
    expect(await project.config.readTelegram()).toBeUndefined();
    expect(said.at(-1)).toContain('Disconnected @old_bot. /telegram links a bot again.');
    expect(linked()).toEqual([]);
  });

  const slack = {
    botToken: 'xoxb-1',
    appToken: 'xapp-1',
    appId: 'A1',
    teamId: 'T1',
    teamName: 'Acme',
    userId: 'U1',
    channelId: 'D1',
  };

  it('/slack links when unlinked, and reports the link otherwise', async () => {
    const { ctx, said, linked } = context();
    await run(ctx, '/slack');
    expect(linked()).toEqual(['slack']);

    await project.config.writeSlack(slack);
    await run(ctx, '/slack');
    expect(said.at(-1)).toContain('Connected to Acme');
    expect(linked()).toEqual(['slack']);
  });

  it('/slack-disconnect just forgets the workspace', async () => {
    const { ctx, said, linked } = context();
    await project.config.writeSlack(slack);
    await run(ctx, '/slack-disconnect');
    expect(await project.config.readSlack()).toBeUndefined();
    expect(said.at(-1)).toContain('Disconnected from Acme. /slack links it again.');
    expect(linked()).toEqual([]);
  });

  it('/context says how full the conversation is', async () => {
    const { ctx, said } = context();
    await run(ctx, '/context');
    expect(said.at(-1)).toContain(
      'about 150k tokens: 75% of the 200k this model holds. /compact frees up room.',
    );
  });

  it('/background switches building in the background on and off, off by default', async () => {
    const { ctx, said } = context();
    await run(ctx, '/background');
    expect(said.at(-1)).toContain('Building in the background is off');
    await run(ctx, '/background on');
    expect((await project.config.readSettings()).backgroundBuild).toBe(true);
    expect(said.at(-1)).toContain('`dazza stop`');
    await run(ctx, '/background off');
    expect((await project.config.readSettings()).backgroundBuild).toBe(false);
  });

  it('/phone-merge switches merging from Slack or Telegram off and on, on by default', async () => {
    const { ctx, said } = context();
    await run(ctx, '/phone-merge');
    expect(said.at(-1)).toContain('Approving from Slack or Telegram merges the work');
    await run(ctx, '/phone-merge off');
    expect((await project.config.readSettings()).phoneMerge).toBe(false);
    expect(said.at(-1)).toContain('only from here or the board');
    await run(ctx, '/phone-merge on');
    expect((await project.config.readSettings()).phoneMerge).toBe(true);
  });

  it('/exit ends the chat', async () => {
    const { ctx, exited } = context();
    await run(ctx, '/quit');
    expect(exited()).toBe(true);
  });
});
