import { basename } from 'node:path';
import { styleText } from 'node:util';
import { Config, type Connection } from '../core/config.js';
import { findBrowser } from '../preview/capture.js';
import { createProvider, PROVIDER_HELP, providerFor } from '../providers/index.js';
import type { ProviderId } from '../providers/types.js';
import { execCommand } from '../util/process.js';

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const MIN_NODE_MAJOR = 20;

/** `dazza doctor`: verify everything Dazza depends on. Exits non-zero if anything is missing. */
export async function doctor(): Promise<void> {
  const connection = await new Config().readConnection();
  const checks = await Promise.all([
    checkNode(),
    checkGit(),
    checkAgent('claude', connection),
    checkAgent('codex', connection),
    checkConnection(connection),
    checkTelegram(),
    checkBrowser(),
  ]);

  for (const check of checks) {
    const mark = check.ok ? styleText('green', '✔') : styleText('red', '✖');
    console.log(`${mark} ${check.label.padEnd(12)} ${styleText('dim', check.detail)}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
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
  const result = await execCommand('git', ['--version']);
  return {
    label: 'git',
    ok: result?.exitCode === 0,
    detail: result ? result.stdout.trim() : 'not installed',
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

async function checkBrowser(): Promise<Check> {
  const browser = findBrowser();
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
