import type { AgentError } from '../providers/types.js';

/** A failure explained for the user, with what to do about it. */
export function explainAgentError(error: AgentError, taskId?: string): string {
  const paused = taskId ? `I’ve paused ${taskId}. ` : '';
  switch (error.kind) {
    case 'usage_limit':
      return error.resetsAt
        ? `You’ve hit your Claude usage limit. ${paused}It resets at ${clock(error.resetsAt)}.`
        : `You’ve hit your Claude usage limit. ${paused}`.trim();
    case 'credits':
      return (
        `Your Anthropic credit balance has run out. ${paused}Top up at ` +
        'https://console.anthropic.com/settings/billing, then /build to carry on.'
      );
    case 'auth':
      return (
        `Claude couldn’t sign in (${error.message}). ${paused}On an API key, /logout and connect ` +
        'again with a working key; on a subscription, run `claude` to sign back in. Then /build.'
      );
    case 'overloaded':
      return `Anthropic is overloaded right now. ${paused}Try again in a few minutes.`;
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
