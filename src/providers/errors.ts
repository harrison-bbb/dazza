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
    return { kind: 'usage_limit', message: text, ...(resetsAt && { resetsAt }) };
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
  return error.kind === 'auth' || error.kind === 'credits';
}
