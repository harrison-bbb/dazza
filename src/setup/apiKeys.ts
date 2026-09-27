import type { ProviderId } from '../providers/types.js';

export type KeyCheck = 'valid' | 'invalid' | 'unreachable';

/** Check an API key by listing models: free, and fails fast on a bad key. */
export async function checkApiKey(
  provider: ProviderId,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  const request =
    provider === 'codex'
      ? { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${apiKey}` } }
      : {
          url: 'https://api.anthropic.com/v1/models?limit=1',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        };
  try {
    const res = await fetchImpl(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'valid';
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
