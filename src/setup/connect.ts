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
  /** Install the agent CLI (npm, machine-wide), showing its output. Resolves whether it worked. */
  install(provider: ProviderId): Promise<boolean>;
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
  // Say up front which agent CLIs are here, rather than after they've picked one.
  const [claude, codex] = await Promise.all([deps.detect('claude'), deps.detect('codex')]);
  const missing = (installed: boolean, cli: string) =>
    installed ? '' : ` · ${cli} isn’t installed yet`;
  const noClaude = missing(claude.installed, 'Claude Code');
  const noCodex = missing(codex.installed, 'Codex');
  const choice = await ui.select('How do you want to connect?', [
    {
      label: 'Claude subscription',
      hint: `Pro or Max, through Claude Code${noClaude}`,
      value: ['claude', 'subscription'] as const,
    },
    {
      label: 'Anthropic API key',
      hint: `pay as you go, with Claude Code${noClaude}`,
      value: ['claude', 'api-key'] as const,
    },
    {
      label: 'ChatGPT subscription',
      hint: `Plus or Pro, through Codex${noCodex}`,
      value: ['codex', 'subscription'] as const,
    },
    {
      label: 'OpenAI API key',
      hint: `pay as you go, with Codex${noCodex}`,
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
  let status = await ensureInstalled(ui, deps, provider);
  if (!status?.installed) return undefined;

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
  // The key is for the agent CLI, so check it's there before asking for one.
  if (!(await ensureInstalled(ui, deps, provider))) return undefined;
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

/**
 * Starting up with a saved connection: make sure it still works, fixing what
 * it can on the spot (installing the CLI, signing back in) rather than sending
 * the user away. Resolves whether Dazza can go ahead.
 */
export async function ensureReady(
  ui: SetupUI,
  deps: SetupDeps,
  connection: Connection,
): Promise<ProviderStatus | undefined> {
  const { provider } = connection;
  const status = await ensureInstalled(ui, deps, provider);
  if (!status?.installed) return undefined;
  if (connection.method !== 'subscription' || status.loggedIn) return status;
  const cli = provider === 'codex' ? 'Codex' : 'Claude Code';
  const signIn = await ui.select(`Your ${cli} sign-in has expired. Sign in again now?`, [
    { label: 'Sign in', hint: 'opens your browser', value: true },
    { label: 'Not now', value: false },
  ]);
  if (!signIn) {
    ui.say(`OK. Run ${PROVIDER_HELP[provider].signIn} to sign in, then start Dazza again.`);
    return undefined;
  }
  await deps.signIn(provider);
  const after = await deps.detect(provider);
  if (after.installed && after.loggedIn) return after;
  ui.say('That didn’t complete. Run dazza again when you’re ready to sign in.');
  return undefined;
}

/**
 * Dazza drives Claude Code or Codex, so it has to be installed. Offer to do it
 * here rather than send the user off to a web page: it's one npm command,
 * shown as it runs, and only on their yes. Resolves what's installed, checked.
 */
async function ensureInstalled(
  ui: SetupUI,
  deps: SetupDeps,
  provider: ProviderId,
): Promise<ProviderStatus | undefined> {
  const found = await deps.detect(provider);
  if (found.installed) return found;
  const cli = provider === 'codex' ? 'Codex' : 'Claude Code';
  const command = INSTALL_COMMANDS[provider];
  const install = await ui.select(
    `Dazza drives ${cli}, which isn’t installed yet. Install it now?`,
    [
      { label: 'Install it', hint: command, value: true },
      { label: 'Not now', value: false },
    ],
  );
  if (!install) {
    ui.say(
      `OK. Install it with ${command} (or see ${PROVIDER_HELP[provider].install}), then run dazza again.`,
    );
    return undefined;
  }
  // npm saying it worked isn't enough: check the CLI is really there now.
  const status = (await deps.install(provider)) ? await deps.detect(provider) : undefined;
  if (!status?.installed) {
    ui.say(
      `That didn’t install. If npm said EACCES or permission denied, it can’t write to its global folder: ` +
        `https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally explains the fix. ` +
        `Or install ${cli} another way (${PROVIDER_HELP[provider].install}), then run dazza again.`,
    );
    return undefined;
  }
  ui.say(`${cli} is installed.`);
  return status;
}

/** The npm package for each agent CLI. */
export const INSTALL_PACKAGES: Record<ProviderId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

const INSTALL_COMMANDS: Record<ProviderId, string> = {
  claude: `npm install -g ${INSTALL_PACKAGES.claude}`,
  codex: `npm install -g ${INSTALL_PACKAGES.codex}`,
};
