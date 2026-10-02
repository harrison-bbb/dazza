import { basename } from 'node:path';
import { styleText } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import { Config, type Connection, type JevLink } from '../core/config.js';
import { newerDazza, updateNotice } from '../core/updates.js';
import { gitInstall, hasGit } from '../git/install.js';
import { JEV_FEATURES, jevOn } from '../jev/features.js';
import { checkJevKey, JEV_PROVIDERS, type JevKeyCheck } from '../jev/providers.js';
import { findBrowser } from '../preview/capture.js';
import { createProvider, PROVIDER_HELP, providerFor } from '../providers/index.js';
import type { ProviderId } from '../providers/types.js';
import { SlackApi } from '../slack/api.js';
import { execCommand } from '../util/process.js';
import { errorMessage } from '../util/text.js';

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const MIN_NODE_MAJOR = 22;

/** `dazza doctor`: verify everything Dazza depends on. Exits non-zero if anything is missing. */
export async function doctor(): Promise<void> {
  const config = new Config();
  const connection = await config.readConnection();
  const checks = await Promise.all([
    checkDazza(config),
    checkNode(),
    checkGit(),
    checkAgent('claude', connection),
    checkAgent('codex', connection),
    checkConnection(connection),
    checkSlack(),
    checkTelegram(),
    checkJev(config),
    checkBrowser(),
  ]);
  // After the rest: reading a secret saved in a file moves it into the keychain.
  checks.push(await checkSecrets(config));

  for (const check of checks) {
    const mark = check.ok ? styleText('green', '✔') : styleText('red', '✖');
    console.log(`${mark} ${check.label.padEnd(12)} ${styleText('dim', check.detail)}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
    console.log('\nFix the ✖ items above, then run `dazza doctor` again.');
  } else {
    console.log('\nAll set. Run `dazza` in your project folder to start.');
  }
}

async function checkDazza(config: Config): Promise<Check> {
  const newer = await newerDazza(config);
  return {
    label: 'Dazza',
    // Out of date still works: a nudge, not a failure.
    ok: true,
    detail: `v${pkg.version}${newer ? ` · ${updateNotice(newer)}` : ''}`,
  };
}

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    label: 'Node.js',
    ok: major >= MIN_NODE_MAJOR,
    detail: `v${process.versions.node}${major >= MIN_NODE_MAJOR ? '' : ` (need ${MIN_NODE_MAJOR}+)`}`,
  };
}

async function checkGit(): Promise<Check> {
  // hasGit first: on a Mac without the developer tools, running git pops up Apple's installer.
  const result = (await hasGit()) ? await execCommand('git', ['--version']) : undefined;
  return {
    label: 'git',
    ok: result?.exitCode === 0,
    detail: result ? result.stdout.trim() : `not installed. ${gitInstall().how}`,
  };
}

async function checkConnection(connection: Connection | undefined): Promise<Check> {
  const how =
    connection &&
    {
      'claude/subscription': 'your Claude subscription (Claude Code)',
      'claude/api-key': 'an Anthropic API key (Claude Code)',
      'codex/subscription': 'your ChatGPT subscription (Codex)',
      'codex/api-key': 'an OpenAI API key (Codex)',
    }[`${connection.provider}/${connection.method}` as const];
  return {
    label: 'Dazza',
    ok: connection !== undefined,
    detail: how ? `connected through ${how}` : 'not connected (run `dazza` to connect)',
  };
}

/** Slack is optional, but a linked app whose token stopped working is worth knowing about. */
async function checkSlack(): Promise<Check> {
  const link = await new Config().readSlack();
  if (!link)
    return { label: 'Slack', ok: true, detail: 'not linked (optional; /slack in the chat)' };
  try {
    await new SlackApi(link.botToken).authTest();
    return { label: 'Slack', ok: true, detail: `linked to ${link.teamName}` };
  } catch (error) {
    return {
      label: 'Slack',
      ok: false,
      detail: `linked to ${link.teamName}, but ${errorMessage(error)} (in the chat, run /slack-disconnect, then /slack)`,
    };
  }
}

async function checkTelegram(): Promise<Check> {
  const link = await new Config().readTelegram();
  return {
    label: 'Telegram',
    // Optional, so being unlinked isn't a failure.
    ok: true,
    detail: link
      ? `linked to @${link.botUsername}`
      : 'not linked (optional; /telegram in the chat)',
  };
}

/** Jev is optional; a key that stopped working is worth knowing about, since it quietly does nothing. */
export async function checkJev(
  config: Config,
  check: (link: JevLink) => Promise<JevKeyCheck> = (link) => checkJevKey(link),
): Promise<Check> {
  const link = await config.readJev();
  if (!link)
    return { label: 'Jev', ok: true, detail: 'not connected (optional; /jev in the chat)' };
  const { name } = JEV_PROVIDERS[link.provider];
  const settings = await config.readSettings();
  const on = JEV_FEATURES.filter((f) => jevOn(settings, f.key)).map((f) => f.label.toLowerCase());
  const doing = on.length > 0 ? on.join(' and ') : 'everything switched off';
  switch (await check(link)) {
    case 'valid':
      return { label: 'Jev', ok: true, detail: `through ${name} · ${doing}` };
    case 'invalid':
      return {
        label: 'Jev',
        ok: false,
        detail: `${name} doesn’t accept the key, so Jev isn’t doing anything (in the chat, /jev, then Key)`,
      };
    default:
      return {
        label: 'Jev',
        ok: true,
        detail: `through ${name}, but couldn’t reach it to check the key`,
      };
  }
}

async function checkSecrets(config: Config): Promise<Check> {
  const places = await config.secretsKeptIn();
  return {
    label: 'Secrets',
    ok: true,
    detail:
      places.length > 0
        ? `your keys and tokens are kept in ${places.join(' and ')}`
        : 'none saved (subscriptions sign in through the agent CLI)',
  };
}

async function checkBrowser(): Promise<Check> {
  const browser = await findBrowser();
  return {
    label: 'Screenshots',
    // Optional: only needed to show the user UI.
    ok: true,
    detail: browser
      ? `using ${basename(browser)}`
      : 'no Chrome found (optional; install Chrome to enable)',
  };
}

/**
 * An agent CLI's install and sign-in. It only has to be working if it's the
 * one Dazza is connected to; the other is shown for information.
 */
async function checkAgent(id: ProviderId, connection: Connection | undefined): Promise<Check> {
  const provider = connection?.provider === id ? createProvider(connection) : providerFor(id);
  const help = PROVIDER_HELP[id];
  const required = connection?.provider === id;
  const status = await provider.detect();
  if (!status.installed) {
    return { label: provider.name, ok: !required, detail: `not installed (${help.install})` };
  }
  const signedIn = status.loggedIn;
  return {
    label: provider.name,
    ok: signedIn || !required,
    detail: signedIn
      ? `v${status.version}, signed in${status.authMethod ? ` via ${status.authMethod}` : ''}${status.plan ? ` · ${status.plan}` : ''}`
      : `v${status.version}, not signed in (run ${help.signIn})`,
  };
}
