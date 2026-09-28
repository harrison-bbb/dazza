import type { AgentError } from './types.js';

/**
 * Work out why a run failed from the status code and message the agent CLI
 * reported. Order matters: "usage credit limit reached" is about credits, and
 * Claude Code has unrelated "limit reached" messages (context, budget) that
 * aren't usage limits.
 */
export function classifyError(
  message: string,
  status?: number | null,
  resetsAt?: string,
): AgentError {
  const text = message.trim() || 'The agent stopped with an error.';
  if (
    /credit balance (is )?too low|usage credit limit|billing_error|spend limit reached|insufficient_quota|exceeded your current quota/i.test(
      text,
    )
  ) {
    return { kind: 'credits', message: text };
  }
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|please run \/login|not logged in|authentication|\b401\b|unauthorized/i.test(
      text,
    )
  ) {
    return { kind: 'auth', message: text };
  }
  if (
    status === 429 ||
    /usage limit|(hit|reached) your .{0,20}limit|weekly limit|session limit|rate[ _-]?limit/i.test(
      text,
    )
  ) {
    const when = resetsAt ?? resetTimeFromMessage(text);
    return { kind: 'usage_limit', message: text, ...(when && { resetsAt: when }) };
  }
  if (
    (status !== undefined && status !== null && status >= 500) ||
    /overloaded|\b529\b|\b503\b/i.test(text)
  ) {
    return { kind: 'overloaded', message: text };
  }
  return { kind: 'failed', message: text };
}

/**
 * Whether a failure can't fix itself by retrying (a bad key, no credit), so
 * there's no point letting the CLI keep trying.
 */
export function isHopeless(error: AgentError): boolean {
  return error.kind === 'auth' || error.kind === 'credits' || error.kind === 'setup';
}

/**
 * The reset time a limit message spells out, e.g. Codex's "try again at 9:08 PM"
 * or "try again in 2 hours 5 minutes". Undefined when it doesn't say.
 */
export function resetTimeFromMessage(message: string, now = new Date()): string | undefined {
  const at = /try again at (\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(message);
  if (at) {
    let hours = Number(at[1]) % 12;
    if (at[3]?.toUpperCase() === 'PM') hours += 12;
    if (!at[3] && Number(at[1]) === 12) hours = 12;
    const reset = new Date(now);
    reset.setHours(hours, Number(at[2]), 0, 0);
    // A time that has already passed today means tomorrow.
    if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
    return reset.toISOString();
  }
  const within =
    /try again in ((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[\s,]*(?:and\s*)?)+)/i.exec(
      message,
    );
  if (within?.[1]) {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    let ms = 0;
    for (const [, amount, unit] of within[1].matchAll(/(\d+)\s*([dhms])/gi)) {
      ms += Number(amount) * (units[unit?.toLowerCase() ?? ''] ?? 0);
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  return undefined;
}
