import pkg from '../../package.json' with { type: 'json' };
import type { Config } from './config.js';

/**
 * Whether a newer Dazza is out, so people on a broken release hear about the
 * fix. Asks npm at most once a day, never waits more than a moment, and never
 * fails loudly: no network just means no notice.
 */

const REGISTRY = 'https://registry.npmjs.org/dazza/latest';
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 1_000;

export interface UpdateOptions {
  now?: Date;
  current?: string;
  /** For tests. */
  fetchLatest?: () => Promise<string | undefined>;
}

/** The newer version's number, if there is one. */
export async function newerDazza(
  config: Config,
  { now = new Date(), current = pkg.version, fetchLatest = latestFromNpm }: UpdateOptions = {},
): Promise<string | undefined> {
  if (process.env.DAZZA_NO_UPDATE_CHECK) return undefined;
  const cached = await config.readUpdateCheck();
  let latest = cached?.latest;
  const checked = Date.parse(cached?.checkedAt ?? '');
  if (!(now.getTime() - checked < CHECK_EVERY_MS)) {
    const found = await fetchLatest().catch(() => undefined);
    if (found) {
      latest = found;
      await config.writeUpdateCheck({ checkedAt: now.toISOString(), latest }).catch(() => {});
    }
  }
  return latest && isNewer(latest, current) ? latest : undefined;
}

/** The one line people see when there's an update. */
export function updateNotice(version: string): string {
  return `Dazza ${version} is out. Update with: npm i -g dazza@latest`;
}

async function latestFromNpm(): Promise<string | undefined> {
  const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return undefined;
  const { version } = (await res.json()) as { version?: unknown };
  return typeof version === 'string' ? version : undefined;
}

/** 0.2.0 > 0.1.9; prereleases (0.2.0-beta) aren't offered. */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate.includes('-')) return false;
  const parts = (v: string) =>
    v
      .split('-')[0]
      ?.split('.')
      .map((n) => Number(n) || 0) ?? [];
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
