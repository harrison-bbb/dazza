import type { Git } from '../git/git.js';

/**
 * What a careful engineer checks before committing: no secrets, nothing that
 * shouldn't be in the repository, nothing enormous. Run on the task's changes
 * before it's handed over; problems go back to the worker to fix first.
 */

/** Credentials that must never be committed. Test keys (sk_test_…) are fine. */
const SECRETS: { name: string; pattern: RegExp }[] = [
  { name: 'a live Stripe key', pattern: /\b(sk|rk)_live_[0-9a-zA-Z]{10,}/ },
  { name: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'an Anthropic API key', pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}/ },
  { name: 'an OpenAI API key', pattern: /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Files that belong on the developer's machine, not in the repository. */
const LOCAL_ONLY: { name: string; pattern: RegExp }[] = [
  {
    name: 'an environment file with real settings',
    pattern: /(^|\/)\.env(\.(?!example|sample|template)[\w.-]+)?$/,
  },
  { name: 'a log file', pattern: /\.log$/ },
  { name: 'installed dependencies', pattern: /(^|\/)node_modules\// },
  { name: 'a macOS folder file', pattern: /(^|\/)\.DS_Store$/ },
  { name: 'a key or certificate', pattern: /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)$/ },
];

/**
 * Placeholder files project templates (create-next-app, create-vite, CRA) ship
 * with. Left in, they're clutter a reviewer has to ask about.
 */
const SCAFFOLD =
  /(^|\/)(public\/(next|vercel|file|globe|window|vite)\.svg|src\/assets\/(react|vue)\.svg|src\/logo\.svg)$/;

/**
 * Signs of unfinished work, in lines the task added. A comment marker only
 * (a to-do app's `status: 'TODO'` is fine), and only in code: a README may
 * well talk about what's next.
 */
const UNFINISHED: { name: string; pattern: RegExp; fix: string }[] = [
  {
    name: 'a TODO',
    pattern: /(\/\/|#|\/\*|^\s*\*|<!--|\{\/\*)\s*(TODO|FIXME|XXX)\b/,
    fix: 'Finish it. If it’s real follow-up work, take the comment out and say so in your handoff’s details',
  },
  {
    name: 'a stub that isn’t implemented',
    pattern: /throw new Error\(\s*['"`]not (yet )?implemented/i,
    fix: 'Implement it, or leave the feature out and say so in your handoff',
  },
  {
    name: 'placeholder text (lorem ipsum)',
    pattern: /lorem ipsum/i,
    fix: 'Use real-looking content: copy that fits the product, or realistic sample data',
  },
];
const PROSE = /\.(md|mdx|txt|rst)$/i;

/** Bigger than this is almost never source code. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Problems with the changes since `from`, as instructions for the worker.
 * Stages everything in the worktree to look, as the commit would.
 */
export async function checkChanges(tree: Git, from: string): Promise<string[]> {
  const problems: string[] = [];
  const files = await tree.stagedFiles(from);
  for (const { path, bytes } of files) {
    const local = LOCAL_ONLY.find((rule) => rule.pattern.test(path));
    if (local) problems.push(`${path} is ${local.name}. Delete it or add it to .gitignore.`);
    else if (bytes > MAX_FILE_BYTES) {
      problems.push(
        `${path} is ${Math.round(bytes / 1024 / 1024)} MB. Leave it out, or explain why it's needed.`,
      );
    }
  }
  for (const { path } of files.filter((f) => SCAFFOLD.test(f.path))) {
    const name = path.split('/').pop() ?? path;
    const users = (await tree.filesMentioning(name)).filter((file) => file !== path);
    if (users.length === 0) {
      problems.push(
        `${path} is a placeholder from the project template and nothing uses it. Delete it.`,
      );
    }
  }
  for (const { path, line } of await tree.stagedAdditions(from)) {
    const secret = SECRETS.find((rule) => rule.pattern.test(line));
    if (secret) {
      problems.push(
        `${path} contains ${secret.name}. Read it from the environment instead, and never commit it.`,
      );
    }
    const unfinished = PROSE.test(path)
      ? undefined
      : UNFINISHED.find((rule) => rule.pattern.test(line));
    if (unfinished) problems.push(`${path} still has ${unfinished.name}. ${unfinished.fix}.`);
  }
  return [...new Set(problems)];
}
