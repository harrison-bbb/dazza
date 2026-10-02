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
import { makePlan, makeTask } from '../fixtures.js';
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

  describe('with the project in view', () => {
    const plan = {
      ...makePlan([
        makeTask({ id: 'T1', title: 'Setup', status: 'closed' }),
        makeTask({ id: 'T2', title: 'Calendar', status: 'review' }),
        makeTask({ id: 'T3', title: 'Checkout', status: 'blocked' }),
        makeTask({ id: 'T4', title: 'Receipts', status: 'planned' }),
        makeTask({ id: 'T12', title: 'Search', status: 'review' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    };
    const permissions = { T3: { command: 'psql', why: 'x' } };

    it('offers the tasks a command can take', () => {
      const ids = (text: string) => commandMenu(text, { plan, permissions }).map((m) => m.label);
      expect(ids('/accept ')).toEqual(['T2', 'T12']);
      expect(ids('/accept t1')).toEqual(['T12']);
      expect(ids('/allow ')).toEqual(['T3']);
      expect(ids('/next ')).toEqual(['T4']);
      expect(ids('/cancel ')).toEqual(['T2', 'T3', 'T4', 'T12']);
      expect(ids('/model ')).toEqual([]);
      expect(commandMenu('/accept ', {})).toEqual([]);
    });

    it('runs a command on the task picked, or leaves room for what to change', () => {
      const [accept] = commandMenu('/accept ', { plan });
      expect(accept).toMatchObject({ value: '/accept T2', hint: 'Calendar · in review' });
      expect(accept?.insert).toBeUndefined();
      expect(commandMenu('/changes ', { plan })[0]).toMatchObject({
        value: '/changes T2',
        insert: true,
      });
    });

    it('puts the commands that fit first', () => {
      const first = (context: Parameters<typeof commandMenu>[1]) =>
        commandMenu('/', context)
          .slice(0, 4)
          .map((m) => m.value);
      expect(first({ plan, permissions })).toEqual(['/allow', '/deny', '/review', '/try']);
      expect(first({ plan: { ...plan, approvedAt: null } })).toEqual([
        '/approve',
        '/scope',
        '/tasks',
        '/dashboard',
      ]);
      expect(first({})[0]).toBe('/dashboard');
    });
  });

  it('lines /help’s descriptions up, wrapping under their column', () => {
    const lines = stripAnsi(helpText(80)).split('\n');
    const changes = lines.findIndex((l) => l.trim().startsWith('/changes <task>'));
    // A usage too long for its column gets a line of its own; the description goes under.
    expect(lines[changes]?.trim()).toBe('/changes <task> <what to change>');
    expect(lines[changes + 1]).toMatch(/^ {28}Send work in review back/);
    for (const line of lines.filter((l) => l.startsWith('  '))) {
      expect(line.length).toBeLessThanOrEqual(78); // say() adds two: 80 in all
    }
    const wrapped = lines.findIndex((l) => l.includes('/settings')) + 1;
    expect(lines[wrapped]).toMatch(/^ {28}\S/);
  });

  it('lists every command in /help, grouped, with the rest mentioned by their parent', () => {
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
    /** Answers to pick from lists, in order: the label to choose (undefined is Esc). */
    const picks: (string | undefined)[] = [];
    const asked: string[] = [];
    /** Lines to type when asked, in order (undefined is Esc). */
    const lines: (string | undefined)[] = [];
    let reconnects = 0;
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
      reconnect: async () => {
        reconnects++;
      },
      confirm: async () => confirmAnswer,
      select: async (question, choices) => {
        asked.push(question);
        const label = picks.shift();
        return label === undefined
          ? undefined
          : choices.find((c) => c.label.startsWith(label))?.value;
      },
      readLine: async () => lines.shift(),
      checkJevKey: async (link) => (link.apiKey === 'good-key' ? 'valid' : 'invalid'),
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
    return {
      ctx,
      said,
      provider,
      picks,
      asked,
      lines,
      reconnects: () => reconnects,
      exited: () => exited,
      linked: () => linked,
    };
  };
  const run = (ctx: CommandContext, line: string) => {
    const { command, args } = parseCommand(line);
    if (!command) throw new Error(`no command for ${line}`);
    return command.run(ctx, args);
  };

  it('/jev asks for a key the first time, then switches features one by one', async () => {
    const { ctx, said, picks, lines } = context();
    picks.push('OpenRouter', 'Model routing', undefined);
    lines.push('good-key');
    await run(ctx, '/jev settings');
    expect(await project.config.readJev()).toEqual({ provider: 'openrouter', apiKey: 'good-key' });
    expect((await project.config.readSettings()).jev).toEqual({ modelRouting: false });
    expect(said.at(-1)).toContain('Jev: through OpenRouter · Model routing: Off');
  });

  it('/model picks from a list with the current one marked, or switches by name', async () => {
    const { ctx, said, picks, asked } = context();
    picks.push('Opus 5.5');
    await run(ctx, '/model');
    expect(asked[0]).toContain('Which model?');
    expect(await project.config.readSettings()).toEqual({ model: 'opus' });
    picks.push(undefined);
    await run(ctx, '/model');
    expect(said[1]).toContain('Kept the model you have');
    said.length = 0;
    said.push('');

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

  it('/settings changes one setting at a time, back to the list until Esc', async () => {
    const { ctx, said, picks, asked, reconnects } = context();
    picks.push(
      'Keep building after you close Dazza', // pick it…
      'On', // …turn it on, back to the list
      'Tasks built at once',
      '3',
      'Desktop notifications',
      'Off',
      undefined, // Esc: done
    );
    await run(ctx, '/settings');
    const settings = await project.config.readSettings();
    expect(settings).toMatchObject({
      backgroundBuild: true,
      parallelTasks: 3,
      desktopNotifications: false,
    });
    expect(reconnects()).toBe(1); // notifications reopen; nothing else needs to
    expect(said.at(-1)).toContain('Keep building after you close Dazza: On');
    expect(said.at(-1)).toContain('Tasks built at once: 3');
    expect(asked.filter((q) => q.startsWith('Settings')).length).toBe(4);
  });

  it('/settings shows each setting’s default, and changes nothing on Esc', async () => {
    const { ctx, said, picks } = context();
    picks.push(undefined);
    await run(ctx, '/settings');
    expect(said.at(-1)).toContain('Nothing changed.');
    expect(await project.config.readSettings()).toEqual({});
  });

  it('/settings leaves a setting alone when the same value is picked', async () => {
    const { ctx, said, picks } = context();
    picks.push('Keep building while you review', 'On', undefined);
    await run(ctx, '/settings');
    expect(said.at(-1)).toContain('Nothing changed.');
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
