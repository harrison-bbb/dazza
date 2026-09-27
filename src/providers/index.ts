import type { Connection } from '../core/config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import type { AgentProvider, ProviderId } from './types.js';

/** The agent CLI Dazza drives for a connection. */
export function createProvider(connection: Connection): AgentProvider {
  return connection.provider === 'codex'
    ? new CodexProvider({ connection })
    : new ClaudeProvider({ connection });
}

/** A provider before any connection exists, e.g. to check it's installed during setup. */
export function providerFor(id: ProviderId): AgentProvider {
  return id === 'codex' ? new CodexProvider() : new ClaudeProvider();
}

/** Where each provider's user goes for billing, signing in, and installing. */
export const PROVIDER_HELP: Record<
  ProviderId,
  { billing: string; signIn: string; install: string; brand: string }
> = {
  claude: {
    brand: 'Claude',
    billing: 'https://console.anthropic.com/settings/billing',
    signIn: '`claude`',
    install: 'https://claude.com/claude-code',
  },
  codex: {
    brand: 'Codex',
    billing: 'https://platform.openai.com/settings/organization/billing',
    signIn: '`codex login`',
    install: '`npm install -g @openai/codex`',
  },
};
