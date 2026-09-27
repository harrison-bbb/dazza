import { styleText } from 'node:util';
import { ClaudeProvider } from '../providers/claude.js';
import { execCommand } from '../util/process.js';

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const MIN_NODE_MAJOR = 20;

/** `dazza doctor`: verify everything Dazza depends on. Exits non-zero if anything is missing. */
export async function doctor(): Promise<void> {
  const checks = await Promise.all([checkNode(), checkGit(), checkClaude()]);

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

async function checkClaude(): Promise<Check> {
  const status = await new ClaudeProvider().detect();
  if (!status.installed) {
    return {
      label: 'Claude Code',
      ok: false,
      detail: 'not installed (https://claude.com/claude-code)',
    };
  }
  return {
    label: 'Claude Code',
    ok: status.loggedIn,
    detail: status.loggedIn
      ? `v${status.version}, signed in${status.authMethod ? ` via ${status.authMethod}` : ''}`
      : `v${status.version}, not signed in (run \`claude\` to log in)`,
  };
}
