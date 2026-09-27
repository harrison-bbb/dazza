export type KeyCheck = 'valid' | 'invalid' | 'unreachable';

/** Check an Anthropic API key by listing models: free, and fails fast on a bad key. */
export async function checkApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'valid';
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
