import type { Connection } from '../core/config.js';
import { PROVIDER_HELP } from '../providers/index.js';
import type { ProviderId, ProviderStatus } from '../providers/types.js';
import type { KeyCheck } from './apiKeys.js';

/** The terminal features setup needs, so the flow can be tested without one. */
export interface SetupUI {
  say(text: string): void;
  select<T>(
    question: string,
    choices: { label: string; hint?: string; value: T; disabled?: boolean }[],
  ): Promise<T | undefined>;
  readLine(options: { prompt: string; mask?: boolean }): Promise<string | undefined>;
}

export interface SetupDeps {
  detect(provider: ProviderId): Promise<ProviderStatus>;
  /** The agent CLI's own interactive sign-in. */
  signIn(provider: ProviderId): Promise<void>;
  checkApiKey(provider: ProviderId, apiKey: string): Promise<KeyCheck>;
}

const KEY_ATTEMPTS = 3;

const KEY_SOURCES: Record<ProviderId, { label: string; url: string }> = {
  claude: { label: 'an Anthropic API key', url: 'https://console.anthropic.com/settings/keys' },
  codex: { label: 'an OpenAI API key', url: 'https://platform.openai.com/api-keys' },
};

/**
 * Connect Dazza to a coding agent: Claude Code or Codex, through a subscription
 * or an API key. Runs on first launch and after /logout. Resolves undefined if
 * the user backs out or it can't be completed.
 */
export async function connect(ui: SetupUI, deps: SetupDeps): Promise<Connection | undefined> {
  ui.say('First, connect Dazza to the AI that will do the coding.');
  const choice = await ui.select('How do you want to connect?', [
    {
      label: 'Claude subscription',
      hint: 'Pro or Max, through Claude Code',
      value: ['claude', 'subscription'] as const,
    },
    {
      label: 'Anthropic API key',
      hint: 'pay as you go, with Claude Code',
      value: ['claude', 'api-key'] as const,
    },
    {
      label: 'ChatGPT subscription',
      hint: 'Plus or Pro, through Codex',
      value: ['codex', 'subscription'] as const,
    },
    {
      label: 'OpenAI API key',
      hint: 'pay as you go, with Codex',
      value: ['codex', 'api-key'] as const,
    },
  ]);
  if (!choice) return undefined;
  const [provider, method] = choice;
  return method === 'subscription'
    ? connectSubscription(ui, deps, provider)
    : connectApiKey(ui, deps, provider);
}

async function connectSubscription(
  ui: SetupUI,
  deps: SetupDeps,
  provider: ProviderId,
): Promise<Connection | undefined> {
  const help = PROVIDER_HELP[provider];
  const cli = provider === 'codex' ? 'Codex' : 'Claude Code';
  let status = await deps.detect(provider);
  if (!status.installed) {
    ui.say(
      `Dazza drives ${cli}, which isn’t installed yet. Install it (${help.install}), then run dazza again.`,
    );
    return undefined;
  }

  if (!status.loggedIn) {
    const signIn = await ui.select(`You’re not signed in to ${cli}. Sign in now?`, [
      { label: 'Sign in', hint: 'opens your browser', value: true },
      { label: 'Not now', value: false },
    ]);
    if (!signIn) return undefined;
    await deps.signIn(provider);
    status = await deps.detect(provider);
    if (!status.installed || !status.loggedIn) {
      ui.say('That didn’t complete. Run dazza again when you’re ready to sign in.');
      return undefined;
    }
  }

  ui.say(`Connected through your ${status.plan ?? help.brand} plan.`);
  return { provider, method: 'subscription' };
}

async function connectApiKey(
  ui: SetupUI,
  deps: SetupDeps,
  provider: ProviderId,
): Promise<Connection | undefined> {
  const source = KEY_SOURCES[provider];
  if (provider === 'codex' && !(await deps.detect('codex')).installed) {
    ui.say(
      `Dazza drives Codex, which isn’t installed yet. Install it (${PROVIDER_HELP.codex.install}), then run dazza again.`,
    );
    return undefined;
  }
  ui.say(`Paste ${source.label}. Create one at ${source.url}`);
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    const apiKey = (await ui.readLine({ prompt: 'API key: ', mask: true }))?.trim();
    if (!apiKey) return undefined;

    const check = await deps.checkApiKey(provider, apiKey);
    if (check === 'valid') {
      ui.say(`Key works. Connected with ${source.label}.`);
      return { provider, method: 'api-key', apiKey };
    }
    ui.say(
      check === 'invalid'
        ? 'That key wasn’t accepted. Check it and try again.'
        : 'Couldn’t reach the API to check the key. Check your connection and try again.',
    );
  }
  return undefined;
}
