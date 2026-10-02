import type { JevLink } from '../core/config.js';
import { JevClient, type JevOptions } from './client.js';

/**
 * Where Dazza can call Jev. Each speaks TypeSafe's own System One API (same
 * request, same answers), so they differ only in the address, the model's
 * name there, and whose key pays for it.
 */
export interface JevProvider {
  id: JevProviderId;
  name: string;
  /** In the picker, after the name. */
  hint: string;
  baseUrl: string;
  model: string;
  /** Where to make a key, and what it's called there. */
  keyUrl: string;
  keyName: string;
}

export const JEV_PROVIDER_IDS = ['typesafe', 'openrouter', 'vercel'] as const;
export type JevProviderId = (typeof JEV_PROVIDER_IDS)[number];

export const JEV_PROVIDERS: Record<JevProviderId, JevProvider> = {
  typesafe: {
    id: 'typesafe',
    name: 'TypeSafe',
    hint: 'Jev’s makers, direct',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    keyUrl: 'https://console.typesafe.ai',
    keyName: 'a TypeSafe API key (API Keys in the console)',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'billed to your OpenRouter credit',
    baseUrl: 'https://openrouter.ai/api',
    model: 'jev-1.13',
    keyUrl: 'https://openrouter.ai/keys',
    keyName: 'an OpenRouter API key',
  },
  vercel: {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    hint: 'billed to your Vercel team',
    baseUrl: 'https://ai-gateway.vercel.sh/typesafe',
    model: 'typesafe-ai/jev',
    keyUrl: 'https://vercel.com/dashboard',
    keyName: 'an AI Gateway API key (AI Gateway → API Keys)',
  },
};

/** A client for the linked provider. */
export function jevClient(
  link: JevLink,
  options: Omit<JevOptions, 'apiKey' | 'baseUrl' | 'model'> = {},
): JevClient {
  const provider = JEV_PROVIDERS[link.provider];
  return new JevClient({
    ...options,
    apiKey: link.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model,
  });
}

export type JevKeyCheck = 'valid' | 'invalid' | 'unreachable';

/**
 * Check a key by asking Jev one small question. There's no free call common to
 * all three, and this one costs a few millionths of a dollar.
 */
export async function checkJevKey(link: JevLink, fetchImpl?: typeof fetch): Promise<JevKeyCheck> {
  const result = await jevClient(link, { timeoutMs: 10_000, ...(fetchImpl && { fetchImpl }) }).ask(
    'Dazza checking its key.',
    { ok: { type: 'noul', instructions: 'Is this a short message?' } },
  );
  if (result.ok) return 'valid';
  return result.error.kind === 'auth' ? 'invalid' : 'unreachable';
}
