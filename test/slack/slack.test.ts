import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SlackLink } from '../../src/core/config.js';
import type { Remote } from '../../src/notify/channel.js';
import { connectSlack, type SlackSetupDeps } from '../../src/setup/slack.js';
import { type Block, type Message, SlackApi, SlackError } from '../../src/slack/api.js';
import {
  fromSlackText,
  homeView,
  notificationMessage,
  replyMessages,
} from '../../src/slack/blocks.js';
import { type Outcome, SlackBridge, type SlackHandlers } from '../../src/slack/bridge.js';
import { createAppUrl, SLACK_MANIFEST } from '../../src/slack/manifest.js';
import { type Envelope, type SocketLike, SocketMode } from '../../src/slack/socket.js';
import { claim } from '../../src/util/lock.js';
import { makePlan, makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

const link: SlackLink = {
  botToken: 'xoxb-1',
  appToken: 'xapp-1',
  appId: 'A1',
  teamId: 'T1',
  teamName: 'Acme',
  userId: 'U_ME',
  channelId: 'D1',
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** Every block's text, flattened, to assert on what the user reads. */
function textOf(blocks: unknown): string {
  return JSON.stringify(blocks);
}

describe('SlackApi', () => {
  it('sends form-encoded arguments with the token in a header, and maps Slack errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('chat.postMessage')
        ? Response.json({ ok: true, channel: 'D1', ts: '1.1' })
        : Response.json({ ok: false, error: 'invalid_auth' });
    }) as typeof fetch;
    const api = new SlackApi('xoxb-secret', fake);

    expect(
      await api.postMessage({ channel: 'D1', text: 'hi', blocks: [{ type: 'divider' }] }),
    ).toEqual({
      channel: 'D1',
      ts: '1.1',
    });
    const body = calls[0]?.init.body as URLSearchParams;
    expect(body.get('channel')).toBe('D1');
    expect(JSON.parse(body.get('blocks') ?? '')).toEqual([{ type: 'divider' }]);
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer xoxb-secret' });
    expect(calls[0]?.url).not.toContain('secret');

    await expect(api.authTest()).rejects.toMatchObject({
      code: 'invalid_auth',
      message: 'Slack didn’t accept the token',
    });
  });

  it('waits out a rate limit once', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
        : Response.json({ ok: true, team_id: 'T1', team: 'Acme' });
    }) as typeof fetch;
    expect(await new SlackApi('xoxb-1', fake).authTest()).toEqual({ teamId: 'T1', team: 'Acme' });
    expect(calls).toBe(2);
  });
});

describe('Slack blocks', () => {
  const where = { project: 'notes-app', boardUrl: 'http://localhost:4777' };

  it('offers approve (with a confirm) and request changes on work ready for review', () => {
    const { text, blocks } = notificationMessage(
      {
        kind: 'review',
        taskId: 'T3',
        title: 'Editor <beta>',
        summary: 'Built the **editor**.',
        facts: ['5 files changed'],
        images: ['/a.png', '/b.png'],
      },
      where,
    );
    expect(text).toBe('T3 is ready for review: Editor <beta>');
    const all = textOf(blocks);
    expect(all).toContain('Editor &lt;beta&gt;');
    expect(all).toContain('Built the **editor**.');
    expect(all).toContain('notes-app  ·  5 files changed  ·  📸 2 screenshots in the thread');
    const actions = blocks.find((b) => b.type === 'actions') as { elements: Block[] };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      'approve',
      'request_changes',
      'board',
    ]);
    expect(actions.elements[0]).toMatchObject({ value: 'T3', style: 'primary' });
    expect(actions.elements[0]?.confirm).toBeDefined();
    expect(actions.elements[2]?.url).toBe('http://localhost:4777/#/tasks/T3');
  });

  it('asks blocked questions with a thread to answer in', () => {
    const { blocks } = notificationMessage(
      { kind: 'blocked', taskId: 'T5', title: 'Payments', question: 'Stripe key?', images: [] },
      where,
    );
    expect(textOf(blocks)).toContain('Needs you · T5');
    expect(textOf(blocks)).toContain('Stripe key?');
    expect(textOf(blocks)).toContain('Reply in this thread');
  });

  it('splits long replies to fit Slack’s limit', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const parts = replyMessages(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.text.length <= 11_000)).toBe(true);
    expect(parts.map((p) => p.text).join('\n')).toBe(long);
  });

  it('turns what the user typed back into plain text', () => {
    expect(fromSlackText('see <https://x.dev|x.dev> &amp; <https://a.io/b|docs> a &lt; b')).toBe(
      'see https://x.dev & docs (https://a.io/b) a < b',
    );
  });

  it('shows the project on the Home tab, and what needs the user', () => {
    const plan = {
      ...makePlan([
        makeTask({ id: 'T1', status: 'closed' }),
        makeTask({ id: 'T2', status: 'review', title: 'Search' }),
        makeTask({ id: 'T3', status: 'blocked' }),
        makeTask({ id: 'T4', status: 'building', title: 'Tags' }),
      ]),
      approvedAt: '2026-09-27T10:00:00Z',
    };
    const view = textOf(homeView({ ...where, plan, building: true, online: true }));
    expect(view).toContain('1 of 4 tasks closed.');
    expect(view).toContain('Building T4: Tags.');
    expect(view).toContain('Stop building');
    expect(view).toContain('Needs you');
    expect(view).toContain('*T2* Search  ·  in review');

    const draft = textOf(
      homeView({ ...where, plan: makePlan(plan.tasks), building: false, online: true }),
    );
    expect(draft).toContain('Approve plan');

    const offline = textOf(homeView({ ...where, plan, building: false, online: false }));
    expect(offline).toContain('Dazza isn’t running');
    expect(offline).not.toContain('"type":"button"');
  });
});

describe('Slack manifest', () => {
  it('uses Socket Mode and only the scopes Dazza needs', () => {
    expect(SLACK_MANIFEST.settings.socket_mode_enabled).toBe(true);
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).toEqual([
      'chat:write',
      'im:history',
      'files:write',
      'reactions:write',
      'commands',
      'users:read',
    ]);
    const url = new URL(createAppUrl());
    expect(JSON.parse(url.searchParams.get('manifest_json') ?? '')).toEqual(SLACK_MANIFEST);
  });
});

/** A WebSocket stand-in that Slack "talks" through. */
class FakeSocket implements SocketLike {
  sent: unknown[] = [];
  closed = false;
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.close ?? []) listener({ data: undefined });
  }

  deliver(message: object): void {
    for (const listener of this.listeners.message ?? [])
      listener({ data: JSON.stringify(message) });
  }
}

describe('SocketMode', () => {
  it('acknowledges deliveries with the handler’s answer, and reconnects when Slack asks', async () => {
    const sockets: FakeSocket[] = [];
    const seen: Envelope[] = [];
    const socket = new SocketMode({
      open: async () => `wss://slack/${sockets.length}`,
      connect: () => {
        const fake = new FakeSocket();
        sockets.push(fake);
        return fake;
      },
      onEnvelope: (envelope) => {
        seen.push(envelope);
        return envelope.type === 'interactive' ? { response_action: 'clear' } : undefined;
      },
      onFatal: () => {},
    });
    socket.start();
    await until(() => sockets.length === 1);
    const first = sockets[0] as FakeSocket;
    first.deliver({ type: 'hello' });
    first.deliver({ type: 'events_api', envelope_id: 'e1', payload: {} });
    first.deliver({ type: 'interactive', envelope_id: 'e2', payload: {} });
    expect(first.sent).toEqual([
      { envelope_id: 'e1' },
      { envelope_id: 'e2', payload: { response_action: 'clear' } },
    ]);

    first.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await until(() => sockets.length === 2);
    expect(first.closed).toBe(true);
    await socket.stop();
    expect(seen.map((e) => e.type)).toEqual(['events_api', 'interactive']);
  });

  it('gives up on a token Slack won’t take', async () => {
    const fatal: SlackError[] = [];
    const socket = new SocketMode({
      open: async () => {
        throw new SlackError('invalid_auth');
      },
      onEnvelope: () => undefined,
      onFatal: (error) => fatal.push(error),
    });
    socket.start();
    await until(() => fatal.length > 0);
    await socket.stop();
    expect(fatal[0]?.code).toBe('invalid_auth');
  });
});

/** Records everything the bridge asks Slack to do. */
class FakeSlack {
  posted: Message[] = [];
  updated: { ts: string; text: string; blocks: Block[] }[] = [];
  reactions: string[] = [];
  views: Block[] = [];
  homes: Block[] = [];
  uploads: { files: string[]; threadTs?: string }[] = [];

  api = {
    postMessage: async (message: Message) => {
      this.posted.push(message);
      return { channel: message.channel, ts: `ts${this.posted.length}` };
    },
    updateMessage: async (_channel: string, ts: string, text: string, blocks: Block[]) => {
      this.updated.push({ ts, text, blocks });
    },
    react: async (_channel: string, ts: string, name: string, on: boolean) => {
      this.reactions.push(`${on ? '+' : '-'}${name}@${ts}`);
    },
    openView: async (_trigger: string, view: Block) => {
      this.views.push(view);
    },
    publishHome: async (_user: string, view: Block) => {
      this.homes.push(view);
    },
    uploadFiles: async (_channel: string, files: string[], threadTs?: string) => {
      this.uploads.push({ files, ...(threadTs && { threadTs }) });
    },
  };
}

describe('SlackBridge', () => {
  const project = useTempProject();

  function bridge(overrides: Partial<SlackHandlers> = {}) {
    const slack = new FakeSlack();
    const messages: { text: string; from: Remote }[] = [];
    const problems: string[] = [];
    const approved: string[] = [];
    const sentBack: { taskId: string; note: string }[] = [];
    let deliver: ((envelope: Envelope) => unknown) | undefined;
    const ok = (message: string): Outcome => ({ ok: true, message });
    const handlers: SlackHandlers = {
      onMessage: (text, from) => messages.push({ text, from }),
      onCommand: async (command) => `ran ${command}`,
      onApprove: async (taskId) => {
        approved.push(taskId);
        return ok(`Approved and closed ${taskId}. Merged into main.`);
      },
      onRequestChanges: async (taskId, note) => {
        sentBack.push({ taskId, note });
        return ok('Requested changes');
      },
      onApprovePlan: async () => ok('Approved. 3 tasks locked in.'),
      home: async () => ({
        project: 'notes-app',
        boardUrl: 'http://localhost:4777',
        plan: undefined,
        building: false,
      }),
      onProblem: (text) => problems.push(text),
      ...overrides,
    };
    const instance = new SlackBridge(link, handlers, {
      lockFile: join(project.root, 'slack.lock'),
      api: slack.api,
      socket: (options) => {
        deliver = options.onEnvelope;
        return { start: () => {}, stop: async () => {} };
      },
    });
    return {
      instance,
      slack,
      messages,
      problems,
      approved,
      sentBack,
      deliver: (envelope: Envelope) => deliver?.(envelope),
      /** Connected: this window has Slack, and deliveries reach the bridge. */
      ready: () => deliver !== undefined,
    };
  }

  const dm = (event: object) => ({
    type: 'events_api',
    envelope_id: 'e',
    payload: { event: { type: 'message', channel_type: 'im', channel: 'D1', ...event } },
  });
  const click = (actionId: string, value: string, message?: { ts: string; blocks: Block[] }) => ({
    type: 'interactive',
    envelope_id: 'e',
    payload: {
      type: 'block_actions',
      user: { id: 'U_ME' },
      trigger_id: 'trigger',
      container: { type: message ? 'message' : 'view' },
      ...(message && { channel: { id: 'D1' }, message }),
      actions: [{ action_id: actionId, value }],
    },
  });

  it('passes on the user’s messages, marks them while it thinks, and answers in place', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);

    b.deliver(dm({ user: 'U_ME', text: 'what’s blocked?', ts: '10.1' }));
    b.deliver(dm({ user: 'U_ME', text: 'edited', ts: '10.2', subtype: 'message_changed' }));
    b.deliver(dm({ bot_id: 'B1', user: 'U_BOT', text: 'my own post', ts: '10.3' }));
    expect(b.messages.map((m) => m.text)).toEqual(['what’s blocked?']);
    await until(() => b.slack.reactions.length > 0);
    expect(b.slack.reactions).toEqual(['+eyes@10.1']);

    await b.instance.reply('T5 is waiting on a key.', b.messages[0]?.from as Remote);
    expect(b.slack.posted.at(-1)).toMatchObject({ channel: 'D1', text: 'T5 is waiting on a key.' });
    expect(b.slack.posted.at(-1)?.threadTs).toBeUndefined();
    expect(b.slack.reactions).toEqual(['+eyes@10.1', '-eyes@10.1', '+white_check_mark@10.1']);
    await b.instance.stop();
  });

  it('turns strangers away without passing them on', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    b.deliver(dm({ user: 'U_STRANGER', channel: 'D9', text: 'deploy prod', ts: '1' }));
    await until(() => b.slack.posted.length > 0);
    expect(b.messages).toEqual([]);
    expect(b.slack.posted[0]?.text).toContain('only take instructions from <@U_ME>');
    await b.instance.stop();
  });

  it('gives thread replies the task they’re about, and answers in the thread', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    await b.instance.notify({
      kind: 'blocked',
      taskId: 'T5',
      title: 'Payments',
      question: 'Stripe key?',
      images: ['/shot.png'],
    });
    expect(b.slack.uploads).toEqual([{ files: ['/shot.png'], threadTs: 'ts1' }]);

    b.deliver(dm({ user: 'U_ME', text: 'use sk_test_123', ts: '20.1', thread_ts: 'ts1' }));
    expect(b.messages[0]?.text).toBe('About T5: use sk_test_123');
    await b.instance.reply('Thanks, unblocked T5.', b.messages[0]?.from as Remote);
    expect(b.slack.posted.at(-1)?.threadTs).toBe('ts1');
    await b.instance.stop();
  });

  it('approves from the button once, and shows the outcome in place of the buttons', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    await b.instance.notify({
      kind: 'review',
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    const message = { ts: 'ts1', blocks: b.slack.posted[0]?.blocks ?? [] };

    b.deliver(click('approve', 'T3', message));
    b.deliver(click('approve', 'T3', message)); // a double tap
    await until(() => b.slack.updated.length > 0);
    expect(b.approved).toEqual(['T3']);
    const update = b.slack.updated[0];
    expect(update?.text).toBe('✅ Approved and closed T3. Merged into main.');
    expect(textOf(update?.blocks)).not.toContain('"type":"actions"');
    await b.instance.stop();
  });

  it('settles the notification when approved from the Home tab', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    await b.instance.notify({
      kind: 'review',
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    b.deliver(click('approve', 'T3'));
    await until(() => b.slack.updated.length > 0);
    expect(b.slack.updated[0]?.ts).toBe('ts1');
    await b.instance.stop();
  });

  it('sends work back with a note from a modal', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    await b.instance.notify({
      kind: 'review',
      taskId: 'T3',
      title: 'Editor',
      facts: [],
      images: [],
    });
    b.deliver(
      click('request_changes', 'T3', { ts: 'ts1', blocks: b.slack.posted[0]?.blocks ?? [] }),
    );
    await until(() => b.slack.views.length > 0);
    const modal = b.slack.views[0] as { private_metadata: string; callback_id: string };

    const submit = (value: string) =>
      b.deliver({
        type: 'interactive',
        envelope_id: 'e',
        payload: {
          type: 'view_submission',
          user: { id: 'U_ME' },
          view: {
            callback_id: modal.callback_id,
            private_metadata: modal.private_metadata,
            state: { values: { note: { note: { value } } } },
          },
        },
      });
    expect(submit('  ')).toEqual({
      response_action: 'errors',
      errors: { note: 'Say what needs to change.' },
    });
    expect(submit('Make the toolbar sticky')).toBeUndefined();
    await until(() => b.slack.updated.length > 0);
    expect(b.sentBack).toEqual([{ taskId: 'T3', note: 'Make the toolbar sticky' }]);
    expect(b.slack.updated[0]?.text).toBe('↩️ Sent back: “Make the toolbar sticky”');
    await b.instance.stop();
  });

  it('runs /dazza commands for the user only', async () => {
    const b = bridge();
    b.instance.start();
    await until(b.ready);
    const command = (user: string, text: string) =>
      b.deliver({
        type: 'slash_commands',
        envelope_id: 'e',
        payload: { user_id: user, text, response_url: 'http://127.0.0.1:9/never' },
      });
    expect(command('U_STRANGER', 'build')).toMatchObject({
      text: expect.stringContaining('only takes their commands'),
    });
    expect(command('U_ME', 'dance')).toMatchObject({
      text: expect.stringContaining('/dazza status'),
    });
    await b.instance.stop();
  });

  it('leaves Slack to the window that has it, and marks the Home tab offline on exit', async () => {
    const first = bridge();
    const second = bridge();
    first.instance.start();
    await until(first.ready);
    second.instance.start();
    await until(() => second.problems.length > 0);
    expect(second.problems[0]).toContain('Another Dazza window is connected to Slack');

    await first.instance.stop();
    expect(textOf(first.slack.homes.at(-1))).toContain('Dazza isn’t running');
    await second.instance.stop();
  });
});

describe('claim', () => {
  const project = useTempProject();

  it('is held by one live process, and taken over from a dead one', async () => {
    const path = join(project.root, 'x.lock');
    const release = await claim(path);
    expect(release).toBeDefined();
    expect(await claim(path)).toBeUndefined();
    await release?.();
    expect(await claim(path)).toBeDefined();

    await writeFile(path, '999999999'); // a process that has since exited
    expect(await claim(path)).toBeDefined();
  });
});

describe('connectSlack', () => {
  function scripted(answers: (string | undefined)[]) {
    const said: string[] = [];
    return {
      said,
      ui: {
        say: (text: string) => said.push(text),
        select: async () => undefined,
        readLine: async () => answers.shift(),
      },
    };
  }

  function deps(overrides: Partial<SlackSetupDeps> = {}) {
    const opened: string[] = [];
    const posted: Message[] = [];
    const value: SlackSetupDeps = {
      api: (token) => ({
        authTest: async () => {
          if (token !== 'xoxb-good') throw new SlackError('invalid_auth');
          return { teamId: 'T1', team: 'Acme', botId: 'B1' };
        },
        appIdOf: async () => 'A1',
        openConnection: async () => {
          if (token !== 'xapp-good') throw new SlackError('invalid_auth');
          return 'wss://x';
        },
        postMessage: async (message) => {
          posted.push(message);
          return { channel: message.channel, ts: '1' };
        },
      }),
      listen: (_token, onMessage) => {
        setTimeout(() => onMessage({ user: 'U_ME', channel: 'D1' }), 5);
        return { stop: async () => {} };
      },
      openUrl: (url) => opened.push(url),
      ...overrides,
    };
    return { value, opened, posted };
  }

  it('creates the app, checks both tokens, finds the user, and says hello', async () => {
    const { ui, said } = scripted(['xapp-good', 'xoxb-bad', 'xoxb-good', 'xapp-good', '']);
    const d = deps();
    const result = await connectSlack(ui, d.value);

    expect(result).toEqual({ ...link, botToken: 'xoxb-good', appToken: 'xapp-good' });
    expect(said.some((s) => s.includes('That’s the app-level token, which comes next'))).toBe(true);
    expect(said.some((s) => s.includes('Slack didn’t accept the token'))).toBe(true);
    expect(d.opened[0]).toContain('manifest_json=');
    expect(d.opened[1]).toBe('https://api.slack.com/apps/A1/general');
    expect(d.opened[2]).toBe('https://slack.com/app_redirect?app=A1&team=T1');
    expect(d.posted[0]).toMatchObject({ channel: 'D1', text: 'Dazza is connected.' });
    expect(said.at(-1)).toBe('Connected to Acme. I just said hello in Slack.');
  });

  it('stops when the user backs out', async () => {
    const { ui } = scripted([undefined]);
    expect(await connectSlack(ui, deps().value)).toBeUndefined();
  });
});
