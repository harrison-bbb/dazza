import { describe, expect, it } from 'vitest';
import { addComment } from '../../src/core/actions.js';
import type { SetupUI } from '../../src/setup/connect.js';
import { connectTelegram } from '../../src/setup/telegram.js';
import { TelegramApi, TelegramError, type Update } from '../../src/telegram/api.js';
import { notificationFor, TelegramBridge } from '../../src/telegram/bridge.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

/** A stand-in for the Bot API: a queue of updates, a record of sent messages. */
class FakeBot {
  sent: { chatId: string; text: string }[] = [];
  updates: Update[] = [];
  goodToken = '123:good';
  conflict = false;

  api(token: string) {
    return {
      getMe: async () => {
        if (token !== this.goodToken) throw new TelegramError('Unauthorized', 401);
        return { username: 'dazza_test_bot', name: 'Dazza' };
      },
      getUpdates: async (offset: number | undefined) => {
        if (this.conflict) throw new TelegramError('Conflict', 409);
        const pending = this.updates.filter((u) => offset === undefined || u.update_id >= offset);
        this.updates = this.updates.filter((u) => !pending.includes(u));
        // Like the real long poll, wait a moment when there's nothing to deliver.
        if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        return pending;
      },
      sendMessage: async (chatId: string, text: string) => {
        this.sent.push({ chatId, text });
      },
    };
  }
}

const message = (id: number, chatId: number, text: string): Update => ({
  update_id: id,
  message: { chat: { id: chatId, type: 'private', first_name: 'Sam' }, text },
});

function scriptedUI(answers: (string | undefined)[]) {
  const said: string[] = [];
  const ui: SetupUI = {
    say: (text) => said.push(text),
    select: async (_q, choices) => choices.find((c) => c.label === answers.shift())?.value,
    readLine: async () => answers.shift(),
  };
  return { ui, said };
}

describe('TelegramApi', () => {
  it('calls the Bot API and surfaces Telegram’s own errors', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(String(url));
      return String(url).endsWith('/getMe')
        ? Response.json({ ok: true, result: { username: 'b', first_name: 'B' } })
        : Response.json(
            { ok: false, error_code: 401, description: 'Unauthorized' },
            { status: 401 },
          );
    }) as typeof fetch;
    const api = new TelegramApi('secret', fake);
    expect(await api.getMe()).toEqual({ username: 'b', name: 'B' });
    await expect(api.sendMessage('1', 'hi')).rejects.toMatchObject({
      code: 401,
      message: 'Unauthorized',
    });
    expect(calls[0]).toBe('https://api.telegram.org/botsecret/getMe');
  });
});

describe('connectTelegram', () => {
  it('links a bot: checks the token, finds the chat, sends a test message', async () => {
    const bot = new FakeBot();
    bot.updates = [message(7, 42, '/start')];
    const { ui, said } = scriptedUI(['Connect Telegram', '123:bad', bot.goodToken, '']);
    const link = await connectTelegram(ui, { optional: true, api: (t) => bot.api(t) });

    expect(link).toEqual({ botToken: bot.goodToken, botUsername: 'dazza_test_bot', chatId: '42' });
    expect(said.some((s) => s.includes('didn’t accept that token'))).toBe(true);
    expect(said.some((s) => s.includes('@BotFather'))).toBe(true);
    expect(bot.sent).toHaveLength(1);
    expect(bot.updates).toEqual([]); // the /start was consumed during setup
  });

  it('takes a typed chat ID', async () => {
    const bot = new FakeBot();
    const { ui } = scriptedUI([bot.goodToken, '987654']);
    expect((await connectTelegram(ui, { optional: false, api: (t) => bot.api(t) }))?.chatId).toBe(
      '987654',
    );
  });

  it('can be skipped during onboarding', async () => {
    const { ui } = scriptedUI(['Skip for now']);
    expect(
      await connectTelegram(ui, { optional: true, api: () => new FakeBot().api('') }),
    ).toBeUndefined();
  });
});

describe('TelegramBridge', () => {
  const link = { botToken: 't', botUsername: 'b', chatId: '42' };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('passes on only the user’s own messages', async () => {
    const bot = new FakeBot();
    const received: string[] = [];
    bot.updates = [
      message(1, 42, '/start'),
      message(2, 999, 'I am a stranger'),
      message(3, 42, 'close T4'),
    ];
    const bridge = new TelegramBridge(link, {
      onMessage: (t) => received.push(t),
      onProblem: () => {},
      api: bot.api('t'),
    });
    bridge.start();
    await until(() => received.length > 0);
    await bridge.stop();
    expect(received).toEqual(['close T4']);
  });

  it('sends to the linked chat', async () => {
    const bot = new FakeBot();
    const bridge = new TelegramBridge(link, {
      onMessage: () => {},
      onProblem: () => {},
      api: bot.api('t'),
    });
    await bridge.send('hello');
    expect(bot.sent).toEqual([{ chatId: '42', text: 'hello' }]);
  });

  it('backs off when another Dazza is reading the same bot', async () => {
    const bot = new FakeBot();
    bot.conflict = true;
    const problems: string[] = [];
    const bridge = new TelegramBridge(link, {
      onMessage: () => {},
      onProblem: (t) => problems.push(t),
      api: bot.api('t'),
    });
    bridge.start();
    await until(() => problems.length > 0);
    await bridge.stop();
    expect(problems[0]).toContain('Another Dazza window');
  });
});

describe('notificationFor', () => {
  const project = useTempProject();

  it('announces work ready for review with its summary', async () => {
    const task = makeTask({
      id: 'T3',
      title: 'Editor',
      status: 'review',
      handoff: {
        summary: 'Built the editor.',
        howToVerify: [],
        checks: [{ name: 'Tests', passed: true }],
        screenshots: [],
        filesChanged: 5,
        submittedAt: '2026-09-27T10:00:00Z',
      },
    });
    await project.store.writePlan(makePlan([task]));
    const text = await notificationFor(
      { type: 'task_finished', task, outcome: 'review' },
      project.store,
    );
    expect(text).toContain('T3 is ready for your review: Editor');
    expect(text).toContain('Built the editor.');
    expect(text).toContain('5 files changed · 1 check passed');
    expect(text).toContain('Reply "close T3"');
  });

  it('carries the question when blocked, and stays quiet when paused', async () => {
    const task = makeTask({ id: 'T5', title: 'Tags', status: 'blocked' });
    await project.store.writePlan(makePlan([task]));
    await addComment(project.store, 'T5', 'Should tags be case-sensitive?', 'dazza');
    const text = await notificationFor(
      { type: 'task_finished', task, outcome: 'blocked' },
      project.store,
    );
    expect(text).toContain('Should tags be case-sensitive?');
    expect(
      await notificationFor({ type: 'task_finished', task, outcome: 'paused' }, project.store),
    ).toBeUndefined();
  });
});
