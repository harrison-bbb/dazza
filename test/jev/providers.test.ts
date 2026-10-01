import { describe, expect, it } from 'vitest';
import { checkJevKey, JEV_PROVIDER_IDS, jevClient } from '../../src/jev/providers.js';

const answered = {
  model: 'jev',
  answers: { ok: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 20 },
};

function recording(status = 200, body: unknown = answered) {
  const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      auth: (init.headers as Record<string, string>).authorization ?? '',
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('Jev providers', () => {
  it('calls each provider at its own address, with its own model name and the key', async () => {
    const expected = {
      typesafe: ['https://api.typesafe.ai/v1/systemone', 'jev-latest'],
      openrouter: ['https://openrouter.ai/api/v1/systemone', 'jev-1.13'],
      vercel: ['https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev'],
    };
    for (const provider of JEV_PROVIDER_IDS) {
      const { seen, fetchImpl } = recording();
      await jevClient({ provider, apiKey: `${provider}-key` }, { fetchImpl }).ask('x', {
        ok: { type: 'noul', instructions: 'ok?' },
      });
      expect([seen[0]?.url, seen[0]?.body.model]).toEqual(expected[provider]);
      expect(seen[0]?.auth).toBe(`Bearer ${provider}-key`);
    }
  });

  it('checks a key with one small question', async () => {
    const link = { provider: 'openrouter', apiKey: 'k' } as const;
    expect(await checkJevKey(link, recording().fetchImpl)).toBe('valid');
    expect(await checkJevKey(link, recording(401, {}).fetchImpl)).toBe('invalid');
    expect(await checkJevKey(link, recording(500, {}).fetchImpl)).toBe('unreachable');
  });
});
