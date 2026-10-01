import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ChoiceQuestion,
  JevClient,
  type NoulQuestion,
  type ScoreQuestion,
} from '../../src/jev/client.js';

const mixed = JSON.parse(
  readFileSync(new URL('../fixtures/jev/mixed.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const questions = {
  tier: {
    type: 'choice',
    instructions: 'How capable a model does this task need?',
    criteria: { fast: 'Mechanical', balanced: 'Ordinary', deep: 'Hard or high-stakes' },
  } satisfies ChoiceQuestion<'fast' | 'balanced' | 'deep'>,
  risky: {
    type: 'noul',
    instructions: 'Does it touch money or credentials?',
  } satisfies NoulQuestion,
  clarity: {
    type: 'score',
    instructions: 'How clear is the task?',
    criteria: ['Vague', 'Workable', 'Precise'],
  } satisfies ScoreQuestion,
};

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that answers with each response in turn, and records what it was sent. */
function replying(...responses: (() => Response)[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    const next = responses[Math.min(seen.length, responses.length) - 1];
    if (!next) throw new Error('no response');
    return next();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchImpl: typeof fetch, extra = {}) =>
  new JevClient({ apiKey: 'ts-secret-key', fetchImpl, retryDelayMs: 0, ...extra });

describe('JevClient', () => {
  it('asks every question in one call and returns typed answers', async () => {
    const { seen, fetchImpl } = replying(json(mixed));
    const result = await client(fetchImpl).ask({ title: 'Add a footer' }, questions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.tier.choice).toBe('balanced');
    expect(result.answers.tier.confidence).toBe(0.81);
    expect(result.answers.risky.noul).toBe(0.07);
    expect(result.answers.clarity.score).toBe(1.05);
    expect(result.usage).toEqual({ inputTokens: 318 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen[0]?.init.method).toBe('POST');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ts-secret-key');
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body).toEqual({ model: 'jev-latest', state: { title: 'Add a footer' }, questions });
    // The key goes in the header only.
    expect(String(seen[0]?.init.body)).not.toContain('ts-secret-key');
  });

  it('uses a different base URL and model when given', async () => {
    const { seen, fetchImpl } = replying(json(mixed));
    await client(fetchImpl, { baseUrl: 'https://proxy.example/', model: 'jev-preview' }).ask(
      'x',
      questions,
    );
    expect(seen[0]?.url).toBe('https://proxy.example/v1/systemone');
    expect(JSON.parse(String(seen[0]?.init.body)).model).toBe('jev-preview');
  });

  it('reports a rejected key without echoing it', async () => {
    const { fetchImpl } = replying(json({ error: { message: 'Invalid API key' } }, 401));
    const result = await client(fetchImpl).ask('x', questions);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'auth', message: 'Jev didn’t accept the TypeSafe key: Invalid API key' },
    });
    expect(JSON.stringify(result)).not.toContain('ts-secret-key');
  });

  it('retries once when busy, then gives up', async () => {
    const once = replying(json({}, 429), json(mixed));
    expect((await client(once.fetchImpl).ask('x', questions)).ok).toBe(true);
    expect(once.seen).toHaveLength(2);

    const twice = replying(json({}, 529), json({}, 529));
    const result = await client(twice.fetchImpl).ask('x', questions);
    expect(result.ok || result.error.kind).toBe('rate_limited');
    expect(twice.seen).toHaveLength(2);
  });

  it('sorts other failures', async () => {
    const kind = async (fetchImpl: typeof fetch) => {
      const result = await client(fetchImpl).ask('x', questions);
      return result.ok ? 'ok' : result.error.kind;
    };
    expect(await kind(replying(json({ detail: 'bad question' }, 422)).fetchImpl)).toBe('invalid');
    expect(await kind(replying(json({}, 500)).fetchImpl)).toBe('unreachable');
    expect(await kind(replying(() => new Response('not json')).fetchImpl)).toBe('bad_response');
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await kind(offline)).toBe('unreachable');
  });

  it('times out rather than hold up the build', async () => {
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const result = await client(hangs, { timeoutMs: 20 }).ask('x', questions);
    expect(result.ok || result.error.kind).toBe('timeout');
  });

  it('stops when the caller does', async () => {
    const stop = new AbortController();
    stop.abort();
    const offline = (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new Error('aborted');
      return json(mixed)();
    }) as typeof fetch;
    const result = await client(offline).ask('x', questions, stop.signal);
    expect(result.ok || result.error.kind).toBe('unreachable');
  });

  it('refuses a reply that skips a question, changes its type, or invents an option', async () => {
    const answers = mixed.answers as Record<string, Record<string, unknown>>;
    const kind = async (changed: Record<string, unknown>) => {
      const { fetchImpl } = replying(json({ ...mixed, answers: { ...answers, ...changed } }));
      const result = await client(fetchImpl).ask('x', questions);
      return result.ok ? 'ok' : result.error.kind;
    };
    expect(await kind({ risky: undefined })).toBe('bad_response');
    expect(await kind({ risky: answers.clarity })).toBe('bad_response');
    expect(await kind({ tier: { ...answers.tier, choice: 'huge' } })).toBe('bad_response');
    expect(await kind({ risky: { type: 'noul', noul: 1.4 } })).toBe('bad_response');
    expect(await kind({})).toBe('ok');
  });

  it('refuses to send a state far too big to be a task', async () => {
    const { seen, fetchImpl } = replying(json(mixed));
    const result = await client(fetchImpl).ask('x'.repeat(200_000), questions);
    expect(result.ok || result.error.kind).toBe('invalid');
    expect(seen).toHaveLength(0);
  });
});
