import { describe, expect, it } from 'vitest';
import { addComment } from '../../src/core/actions.js';
import { notificationFor } from '../../src/notify/notification.js';
import type { SetupUI } from '../../src/setup/connect.js';
import { connectTelegram } from '../../src/setup/telegram.js';
import { type Keyboard, TelegramApi, TelegramError, type Update } from '../../src/telegram/api.js';
import { TelegramBridge, telegramText } from '../../src/telegram/bridge.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

/** A stand-in for the Bot API: a queue of updates, a record of sent messages. */
class FakeBot {
  sent: { chatId: string; text: string; id: number; keyboard?: Keyboard; replyTo?: number }[] = [];
  keyboards: { messageId: number; keyboard?: Keyboard }[] = [];
  answered: string[] = [];
  photos: { chatId: string; file: string }[] = [];
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
      sendMessage: async (
        chatId: string,
        text: string,
        options: { keyboard?: Keyboard; replyTo?: number } = {},
      ) => {
        const id = 100 + this.sent.length;
        this.sent.push({ chatId, text, id, ...options });
        return id;
      },
      setKeyboard: async (_chatId: string, messageId: number, keyboard?: Keyboard) => {
        this.keyboards.push({ messageId, ...(keyboard && { keyboard }) });
      },
      answerButton: async (id: string) => {
        this.answered.push(id);
      },
      sendPhoto: async (chatId: string, file: string) => {
        this.photos.push({ chatId, file });
      },
    };
  }
}

const message = (id: number, chatId: number, text: string, replyTo?: number): Update => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: chatId, type: 'private', first_name: 'Sam' },
    text,
    ...(replyTo !== undefined && { reply_to_message: { message_id: replyTo } }),
  },
});
const press = (id: number, messageId: number, data: string, chatId = 42): Update => ({
  update_id: id,
  callback_query: {
    id: `cb${id}`,
    data,
    message: { message_id: messageId, chat: { id: chatId, type: 'private' } },
  },
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
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  function bridge(bot: FakeBot) {
    const received: string[] = [];
    const problems: string[] = [];
    const approved: string[] = [];
    const sentBack: string[] = [];
    const instance = new TelegramBridge(link, {
      onMessage: (text) => received.push(text),
      onCommand: async (command) => `ran ${command}`,
      onApprove: async (taskId) => {
        approved.push(taskId);
        return { ok: true, message: `Approved and closed ${taskId}. Merged into main.` };
      },
      onRequestChanges: async (taskId, note) => {
        sentBack.push(`${taskId}: ${note}`);
        return { ok: true, message: 'Requested changes' };
      },
      onPermission: async (taskId, allow) => {
        sentBack.push(`${taskId}: ${allow ? 'allowed' : 'refused'}`);
        return { ok: true, message: allow ? 'Allowed' : 'Refused' };
      },
      onProblem: (text) => problems.push(text),
      api: bot.api('t'),
    });
    return { instance, received, problems, approved, sentBack };
  }

  it('passes on only the user’s own messages, and runs phone commands', async () => {
    const bot = new FakeBot();
    bot.updates = [
      message(1, 42, '/start'),
      message(2, 999, 'I am a stranger'),
      message(3, 42, 'close T4'),
      message(4, 42, '/status'),
    ];
    const b = bridge(bot);
    b.instance.start();
    await until(() => bot.sent.length > 0);
    await b.instance.stop();
    expect(b.received).toEqual(['close T4']);
    expect(bot.sent.map((m) => m.text)).toEqual(['ran status']);
  });

  it('keeps the words sent with a photo, and says there was one', async () => {
    const bot = new FakeBot();
    bot.updates = [
      {
        update_id: 5,
        message: {
          message_id: 5,
          chat: { id: 42, type: 'private', first_name: 'Sam' },
          caption: 'this button is broken',
          photo: [{}],
        },
      },
    ];
    const b = bridge(bot);
    b.instance.start();
    await until(() => b.received.length > 0);
    await b.instance.stop();
    expect(b.received[0]).toContain('this button is broken');
    expect(b.received[0]).toContain('attached a photo or file');
  });

  it('sends to the linked chat, screenshots after', async () => {
    const bot = new FakeBot();
    await bridge(bot).instance.send('hello', ['/shots/a.png']);
    expect(bot.sent).toMatchObject([{ chatId: '42', text: 'hello' }]);
    expect(bot.photos).toEqual([{ chatId: '42', file: '/shots/a.png' }]);
  });

  it('approves from the buttons, with a confirm step, once', async () => {
    const bot = new FakeBot();
    const b = bridge(bot);
    await b.instance.notify({
      kind: 'review',
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    const note = bot.sent[0];
    expect(note?.keyboard?.[0]?.map((k) => k.callback_data)).toEqual(['approve:T3', 'changes:T3']);

    bot.updates = [press(1, 100, 'approve:T3')];
    b.instance.start();
    await until(() => bot.keyboards.length > 0);
    expect(bot.keyboards[0]?.keyboard?.[0]?.[0]?.callback_data).toBe('confirm:T3');
    expect(b.approved).toEqual([]); // not until confirmed

    bot.updates = [press(2, 100, 'confirm:T3'), press(3, 100, 'confirm:T3')];
    await until(() => bot.sent.length > 1);
    await b.instance.stop();
    expect(b.approved).toEqual(['T3']);
    expect(bot.keyboards.at(-1)).toEqual({ messageId: 100 }); // buttons removed
    expect(bot.sent.at(-1)).toMatchObject({
      text: '✅ Approved and closed T3. Merged into main.',
      replyTo: 100,
    });
    expect(bot.answered).toEqual(['cb1', 'cb2', 'cb3']);
  });

  it('asks what to change, and sends the reply back as the note', async () => {
    const bot = new FakeBot();
    const b = bridge(bot);
    await b.instance.notify({
      kind: 'review',
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    bot.updates = [press(1, 100, 'changes:T3')];
    b.instance.start();
    await until(() => bot.sent.length > 1);
    expect(bot.sent[1]?.text).toContain('What should change in T3?');

    bot.updates = [message(2, 42, 'Make the toolbar sticky', 101)];
    await until(() => b.sentBack.length > 0);
    await until(() => bot.sent.length > 2);
    await b.instance.stop();
    expect(b.sentBack).toEqual(['T3: Make the toolbar sticky']);
    expect(bot.sent.at(-1)?.text).toBe('↩️ Sent T3 back with your note.');
  });

  it('gives replies to a notification the task they’re about', async () => {
    const bot = new FakeBot();
    const b = bridge(bot);
    await b.instance.notify({ kind: 'blocked', taskId: 'T5', title: 'Payments', images: [] });
    bot.updates = [message(1, 42, 'use sk_test_123', 100)];
    b.instance.start();
    await until(() => b.received.length > 0);
    await b.instance.stop();
    expect(b.received).toEqual(['About T5: use sk_test_123']);
  });

  it('backs off when another Dazza is reading the same bot', async () => {
    const bot = new FakeBot();
    bot.conflict = true;
    const b = bridge(bot);
    b.instance.start();
    await until(() => b.problems.length > 0);
    await b.instance.stop();
    expect(b.problems[0]).toContain('Another Dazza window');
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
        criteria: [],
        checks: [{ name: 'Tests', passed: true }],
        screenshots: ['T3/editor-desktop.png'],
        filesChanged: 5,
        submittedAt: '2026-09-27T10:00:00Z',
      },
    });
    await project.store.writePlan(makePlan([task]));
    const note = await notificationFor(
      { type: 'task_finished', task, outcome: 'review' },
      project.store,
    );
    const text = note && telegramText(note);
    expect(note?.images).toEqual([project.store.mediaFile('T3/editor-desktop.png')]);
    expect(text).toContain('T3 is ready for your review: Editor');
    expect(text).toContain('Built the editor.');
    expect(text).toContain('5 files changed · 1 check passed');
    expect(note?.kind).toBe('review');
  });

  it('carries the question when blocked, and stays quiet when paused', async () => {
    const task = makeTask({ id: 'T5', title: 'Tags', status: 'blocked' });
    await project.store.writePlan(makePlan([task]));
    await addComment(project.store, 'T5', 'Should tags be case-sensitive?', { actor: 'dazza' });
    const note = await notificationFor(
      { type: 'task_finished', task, outcome: 'blocked' },
      project.store,
    );
    expect(note && telegramText(note)).toContain('Should tags be case-sensitive?');
    expect(
      await notificationFor({ type: 'task_finished', task, outcome: 'paused' }, project.store),
    ).toBeUndefined();
  });
});
