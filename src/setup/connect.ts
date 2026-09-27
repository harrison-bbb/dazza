import type { Connection } from '../core/config.js';
import type { ProviderStatus } from '../providers/types.js';
import type { KeyCheck } from './anthropic.js';

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
  detectClaude(): Promise<ProviderStatus>;
  /** Interactive `claude auth login`. */
  signInToClaude(): Promise<void>;
  checkApiKey(apiKey: string): Promise<KeyCheck>;
}

const KEY_ATTEMPTS = 3;

/**
 * Connect Dazza to a coding agent. Runs on first launch and after /logout.
 * Resolves undefined if the user backs out or it can't be completed.
 */
export async function connect(ui: SetupUI, deps: SetupDeps): Promise<Connection | undefined> {
  ui.say('First, connect Dazza to the AI that will do the coding.');
  const method = await ui.select('How do you want to connect?', [
    {
      label: 'Claude subscription',
      hint: 'Pro or Max, through your Claude Code sign-in',
      value: 'subscription' as const,
    },
    { label: 'Anthropic API key', hint: 'pay as you go', value: 'api-key' as const },
    { label: 'Codex', hint: 'coming soon', value: 'codex' as const, disabled: true },
  ]);

  if (method === 'subscription') return connectSubscription(ui, deps);
  if (method === 'api-key') return connectApiKey(ui, deps);
  return undefined;
}

async function connectSubscription(ui: SetupUI, deps: SetupDeps): Promise<Connection | undefined> {
  let status = await deps.detectClaude();
  if (!status.installed) {
    ui.say(
      'Dazza drives Claude Code, which isn’t installed yet. Install it from ' +
        'https://claude.com/claude-code, then run dazza again.',
    );
    return undefined;
  }

  if (!status.loggedIn) {
    const signIn = await ui.select('You’re not signed in to Claude Code. Sign in now?', [
      { label: 'Sign in', hint: 'opens your browser', value: true },
      { label: 'Not now', value: false },
    ]);
    if (!signIn) return undefined;
    await deps.signInToClaude();
    status = await deps.detectClaude();
    if (!status.installed || !status.loggedIn) {
      ui.say('That didn’t complete. Run dazza again when you’re ready to sign in.');
      return undefined;
    }
  }

  ui.say(`Connected through your ${status.plan ?? 'Claude'} plan.`);
  return { provider: 'claude', method: 'subscription' };
}

async function connectApiKey(ui: SetupUI, deps: SetupDeps): Promise<Connection | undefined> {
  ui.say('Paste an Anthropic API key. Create one at https://console.anthropic.com/settings/keys');
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    const apiKey = (await ui.readLine({ prompt: 'API key: ', mask: true }))?.trim();
    if (!apiKey) return undefined;

    const check = await deps.checkApiKey(apiKey);
    if (check === 'valid') {
      ui.say('Key works. Connected with your Anthropic API key.');
      return { provider: 'claude', method: 'api-key', apiKey };
    }
    ui.say(
      check === 'invalid'
        ? 'Anthropic didn’t accept that key. Check it and try again.'
        : 'Couldn’t reach Anthropic to check the key. Check your connection and try again.',
    );
  }
  return undefined;
}
