import { PROVIDER_HELP } from '../providers/index.js';
import type { AgentError, ProviderId } from '../providers/types.js';

/** A failure explained for the user, with what to do about it. */
export function explainAgentError(
  error: AgentError,
  {
    taskId,
    provider = 'claude',
    method,
  }: { taskId?: string; provider?: ProviderId; method?: 'subscription' | 'api-key' } = {},
): string {
  const help = PROVIDER_HELP[provider];
  const paused = taskId ? `I’ve paused ${taskId}. ` : '';
  switch (error.kind) {
    case 'usage_limit':
      return error.resetsAt
        ? `You’ve hit your ${help.brand} usage limit. ${paused}It resets at ${clock(error.resetsAt)}.`
        : `You’ve hit your ${help.brand} usage limit. ${paused}`.trim();
    case 'credits':
      return `Your API credit has run out. ${paused}Top up at ${help.billing}, then /build to carry on.`;
    case 'auth': {
      const fix =
        method === 'api-key'
          ? 'Run /logout and connect again with a working key.'
          : method === 'subscription'
            ? `Run ${help.signIn} in a terminal to sign back in.`
            : `On an API key, /logout and connect again with a working key; on a subscription, run ${help.signIn} to sign back in.`;
      return `${help.brand} couldn’t sign in (${error.message}). ${paused}${fix}${taskId ? ' Then /build.' : ''}`;
    }
    case 'overloaded':
      return `${help.brand} is overloaded right now. ${paused}Try again in a few minutes.`;
    case 'setup':
    case 'failed':
      return error.message;
  }
}

/** A time like "5:40 PM", with the day if it isn't today. */
export function clock(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
