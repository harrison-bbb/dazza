import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { defaultConfigDir } from '../core/config.js';

/** Docker commands that only look, or build an image. */
const DOCKER_READ_ONLY = ['ps', 'images', 'logs', 'inspect', 'version', 'info', 'build'];

/**
 * What Dazza's builder may do on its own, what needs the user's say-so, and
 * what it never does. Applied to every tool call before it runs (see hook.ts),
 * so safety doesn't rest on the model deciding to behave.
 *
 * The line is drawn where a careful engineer on someone else's systems would
 * draw it: work freely inside the task's own checkout; ask before anything
 * that changes the world outside it; never ship, push, or touch credentials.
 */

export type Decision =
  | { kind: 'allow' }
  /** Needs the user's OK. The builder can ask with ask_permission. */
  | { kind: 'ask'; reason: string }
  /** Not done, even if asked. */
  | { kind: 'never'; reason: string };

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface Context {
  /** Where this agent may write: the task's worktree (or the project, for the manager). */
  workspace: string;
  home?: string;
  tmp?: string;
}

const allow: Decision = { kind: 'allow' };
const ask = (reason: string): Decision => ({ kind: 'ask', reason });
const never = (reason: string): Decision => ({ kind: 'never', reason });

export function judge(call: ToolCall, context: Context): Decision {
  const ctx: Ctx = { home: homedir(), tmp: tmpdir(), ...context, cwd: context.workspace };
  const path = stringField(call.input, 'file_path') ?? stringField(call.input, 'notebook_path');

  switch (call.tool) {
    case 'Bash':
      return judgeCommand(stringField(call.input, 'command') ?? '', ctx);
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? judgeWrite(path, ctx) : allow;
    case 'Read':
    case 'Grep':
    case 'Glob':
      return judgeRead(path ?? stringField(call.input, 'path'), ctx);
    // Codex edits files with a patch; every file it touches has to be allowed.
    case 'apply_patch':
      return worst(
        patchedFiles(stringField(call.input, 'command') ?? '').map((f) => judgeWrite(f, ctx)),
      );
    // Codex can type into a shell it started: check what's typed like a command.
    case 'write_stdin': {
      const typed = stringField(call.input, 'chars') ?? '';
      return typed.trim() ? judgeCommand(typed, ctx) : allow;
    }
    // Claude Code's Monitor runs a script, or listens to a WebSocket.
    case 'Monitor': {
      const url = objectField(call.input, 'ws')?.url;
      if (typeof url === 'string') {
        return isLocal(url) ? allow : ask('It listens to an outside service.');
      }
      return judgeCommand(stringField(call.input, 'command') ?? '', ctx);
    }
    default: {
      // Any other tool that runs a command is a way to run commands: check it
      // like one, so a new tool can't be a way around these rules. Dazza's own
      // tools are exempt (ask_permission names a command; it doesn't run it).
      const command = stringField(call.input, 'command');
      return command && !call.tool.startsWith('mcp__') ? judgeCommand(command, ctx) : allow;
    }
  }
}

/** A URL on this machine. */
function isLocal(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function objectField(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = input[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The files a Codex patch adds, updates, deletes or moves to. Exported for tests. */
export function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) =>
    (m[1] ?? '').trim(),
  );
}

/** The strictest of several decisions: never beats ask, ask beats allow. */
function worst(decisions: Decision[]): Decision {
  return (
    decisions.find((d) => d.kind === 'never') ?? decisions.find((d) => d.kind === 'ask') ?? allow
  );
}

type Ctx = Required<Context> & {
  /** Where relative paths point: the workspace, unless a `cd` moved it. */
  cwd: string;
};

function judgeWrite(path: string, ctx: Ctx): Decision {
  const target = resolve(ctx.workspace, expandHome(path, ctx.home));
  if (isSecret(target, ctx.home)) return never(`${path} holds credentials.`);
  if (inside(target, `${ctx.workspace}/.git`) || /\/\.git\/hooks\//.test(target)) {
    return never('Git internals and hooks are off limits.');
  }
  if (inside(target, ctx.workspace) || isScratch(target, ctx)) return allow;
  return never(`${path} is outside this task's checkout (${ctx.workspace}).`);
}

function judgeRead(path: string | undefined, ctx: Ctx): Decision {
  if (!path) return allow;
  const target = resolve(ctx.workspace, expandHome(path, ctx.home));
  return isSecret(target, ctx.home) ? never(`${path} holds credentials.`) : allow;
}

/** Files and folders that hold keys, tokens or passwords. */
const SECRET_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker/config.json',
  '.config/gcloud',
  '.config/gh',
  '.config/dazza',
  '.azure',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'Library/Keychains',
];

function isSecret(target: string, home: string): boolean {
  // Dazza's own keys too, wherever DAZZA_CONFIG_DIR or XDG_CONFIG_HOME put them.
  return (
    SECRET_PATHS.some((p) => inside(target, resolve(home, p))) ||
    inside(target, resolve(defaultConfigDir()))
  );
}

/**
 * A shell command, judged segment by segment (`a && b | c`), taking the most
 * cautious answer. Wrappers like `sudo`, `npx` and `sh -c "…"` are looked through.
 */
function judgeCommand(command: string, start: Ctx): Decision {
  if (
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command) ||
    /\b(ba)?sh\s+<\(\s*(curl|wget)/.test(command)
  ) {
    return never('Running a script straight from the internet.');
  }
  let worst: Decision = allow;
  let ctx = start;
  for (const segment of segments(command)) {
    // `cd ..` changes what later relative paths mean.
    const cd = /^(?:cd|pushd)\s+(.+)$/.exec(segment)?.[1];
    if (cd) {
      ctx = { ...ctx, cwd: resolve(ctx.cwd, expandHome(unquote(cd), ctx.home)) };
      continue;
    }
    const decision = judgeSegment(segment, ctx);
    if (decision.kind === 'never') return decision;
    if (decision.kind === 'ask' && worst.kind === 'allow') worst = decision;
  }
  return worst;
}

function judgeSegment(segment: string, ctx: Ctx): Decision {
  // Redirects write files too: `> ~/.zshrc`.
  const redirects = [...segment.matchAll(/(?:^|[^0-9&<>])>>?\s*([^\s;&|<>]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((t) => !t.startsWith('/dev/') && !t.startsWith('&'));
  if (outsideTargets(redirects, ctx)) return never('Writing outside this task’s checkout.');

  let words = splitWords(segment);
  if (words.some((w) => isSecret(resolve(ctx.cwd, expandHome(w, ctx.home)), ctx.home))) {
    return never('That touches files holding credentials.');
  }
  // Leading VAR=value assignments.
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
  const [program = '', ...args] = words;
  const base = program.split('/').at(-1) ?? program;

  if (['sudo', 'su', 'doas', 'pkexec'].includes(base)) {
    return never('Nothing runs as another user, root included.');
  }
  // Look through runners and shells to what they run.
  if (['npx', 'bunx', 'pnpx', 'time', 'nice', 'nohup', 'env', 'exec', 'xargs'].includes(base)) {
    return judgeSegment(args.filter((a) => !a.startsWith('-')).join(' '), ctx);
  }
  if ((base === 'pnpm' || base === 'yarn') && (args[0] === 'dlx' || args[0] === 'exec')) {
    return judgeSegment(args.slice(1).join(' '), ctx);
  }
  if (['sh', 'bash', 'zsh', 'dash'].includes(base) && args[0] === '-c' && args[1]) {
    return judgeCommand(args[1], ctx);
  }
  if (base === 'eval')
    return ask('It runs a command built at run time, which can’t be checked first.');

  const verb = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));

  switch (base) {
    case 'git':
      return judgeGit(args, ctx);
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      return outsideTargets(args, ctx)
        ? never('Deleting files outside this task’s checkout.')
        : allow;
    case 'mv':
    case 'cp':
    case 'ln':
    case 'rsync':
    case 'tee':
    case 'touch':
    case 'mkdir':
      return outsideTargets(
        args.slice(base === 'tee' || base === 'touch' || base === 'mkdir' ? 0 : -1),
        ctx,
      )
        ? never('Writing outside this task’s checkout.')
        : allow;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return outsideTargets(args, ctx) || (has('-R') && args.includes('/'))
        ? never('Changing permissions outside this task’s checkout.')
        : allow;
    case 'find': {
      const firstFlag = args.findIndex((a) => a.startsWith('-'));
      const starts = firstFlag < 0 ? args : args.slice(0, firstFlag);
      if (!outsideTargets(starts, ctx)) return allow;
      return has('-delete') || args.includes('-exec') || args.includes('-execdir')
        ? never('Deleting or changing files outside this task’s checkout.')
        : never('Searching outside this task’s checkout. Everything the task needs is in it.');
    }
    case 'dd':
    case 'mkfs':
    case 'fdisk':
    case 'diskutil':
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'launchctl':
    case 'systemctl':
    case 'crontab':
      return never(`${base} changes the machine itself, not the project.`);
    case 'security':
      return never('The keychain holds the user’s passwords.');
    case 'pkill':
    case 'killall':
      return ask('Stopping processes by name can stop the user’s own programs too.');
    case 'kill':
      return args.includes('-1') ? never('That stops every process the user owns.') : allow;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (['publish', 'unpublish', 'deprecate', 'owner', 'access', 'dist-tag'].includes(verb)) {
        return never('Publishing packages is the user’s call, and a release.');
      }
      if (['login', 'adduser', 'token'].includes(verb))
        return never('Registry accounts are off limits.');
      // Changing what's installed for the whole machine; listing it is fine.
      const installs = ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'update', 'upgrade'];
      if ((has('-g', '--global') && installs.includes(verb)) || verb === 'link') {
        return ask('It installs outside the project, for the whole machine.');
      }
      return allow;
    }
    case 'pip':
    case 'pip3':
      return has('--user', '--break-system-packages')
        ? ask('It installs outside the project.')
        : allow;
    case 'brew':
    case 'apt':
    case 'apt-get':
    case 'yum':
    case 'dnf':
    case 'port':
      return ['install', 'uninstall', 'remove', 'upgrade', 'reinstall'].includes(verb)
        ? ask('It installs or removes software for the whole machine.')
        : allow;
    case 'cargo':
    case 'gem':
    case 'twine':
    case 'poetry':
      return ['publish', 'push', 'upload'].includes(verb)
        ? never('Publishing packages is the user’s call, and a release.')
        : allow;
    case 'docker':
    case 'podman':
      if (['push', 'login'].includes(verb)) return never('Pushing images is a release.');
      if (verb === 'system' || verb === 'volume' || (verb === 'image' && has('prune', 'rm'))) {
        return ask('It can delete data other projects rely on.');
      }
      // Looking and building are fine. Containers run on the machine, not in the
      // checkout: they outlive the task, and the user's own may be among them.
      return DOCKER_READ_ONLY.includes(verb)
        ? allow
        : ask('It starts or changes containers on the machine, which keep running after the task.');
    case 'open':
    case 'xdg-open':
    case 'osascript':
      return ask('It opens or controls apps on the user’s machine, outside the task.');
    case 'vercel':
    case 'netlify':
    case 'flyctl':
    case 'fly':
    case 'heroku':
    case 'firebase':
    case 'wrangler':
    case 'railway':
    case 'render':
    case 'serverless':
    case 'sls':
    case 'sam':
    case 'cdk':
    case 'amplify':
    case 'eb':
      return ['dev', 'login', 'whoami', '--version', 'help', 'init', 'synth', 'build'].includes(
        verb,
      )
        ? allow
        : never('Deploying or changing live infrastructure is the user’s call.');
    case 'terraform':
    case 'tofu':
    case 'pulumi':
      return ['apply', 'destroy', 'import', 'up', 'refresh', 'taint'].includes(verb) ||
        (verb === 'state' && !has('list', 'show'))
        ? never('Changing live infrastructure is the user’s call.')
        : allow;
    case 'kubectl':
    case 'helm':
    case 'oc':
      return [
        'get',
        'describe',
        'logs',
        'version',
        'explain',
        'config',
        'template',
        'lint',
        'diff',
      ].includes(verb)
        ? allow
        : never('Changing a cluster is the user’s call.');
    case 'aws':
    case 'gcloud':
    case 'gsutil':
    case 'az':
    case 'doctl':
      return /(^|\s)(create|delete|put|update|remove|terminate|run-instances|deploy|rm|rb|mv|cp|sync|set|attach|detach|modify|start|stop|reboot|invoke|publish|send)/.test(
        args.join(' '),
      )
        ? never('Changing cloud resources is the user’s call.')
        : ask('It talks to a live cloud account.');
    case 'gh':
      return ['release', 'secret', 'workflow', 'repo', 'api'].includes(verb) ||
        (verb === 'pr' && !has('view', 'list', 'diff', 'checks', 'status'))
        ? never('Changing things on GitHub is the user’s call.')
        : allow;
    case 'psql':
    case 'mysql':
    case 'mariadb':
    case 'mongosh':
    case 'mongo':
    case 'redis-cli':
    case 'sqlcmd':
    case 'cqlsh':
      return remoteDatabase(segment)
        ? ask('It connects to a database that isn’t on this machine.')
        : destructiveSql(segment)
          ? ask('It deletes data.')
          : allow;
    case 'prisma':
      return /migrate\s+(reset|deploy)|db\s+push.*(--force-reset|--accept-data-loss)/.test(segment)
        ? ask('It can wipe or change a database’s data.')
        : allow;
    case 'curl':
    case 'wget':
    case 'http':
    case 'httpie':
      return changesRemote(args) ? ask('It sends a change to an outside service.') : allow;
    case 'ssh':
    case 'scp':
    case 'sftp':
      return never('Other machines are off limits.');
    default:
      return destructiveSql(segment) ? ask('It deletes data.') : allow;
  }
}

function judgeGit(args: string[], ctx: Ctx): Decision {
  const verb = args.find((a) => !a.startsWith('-') && !a.startsWith('-C')) ?? '';
  const rest = args.slice(args.indexOf(verb) + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  switch (verb) {
    case 'push':
      return never('Dazza never pushes. The user decides what leaves their machine.');
    case 'remote':
      return has('add', 'set-url', 'remove', 'rm', 'rename')
        ? never('Remotes are the user’s to set up.')
        : allow;
    case 'config':
      return has('--global', '--system')
        ? never('Git settings for the whole machine are off limits.')
        : allow;
    case 'checkout':
    case 'switch':
      // Files can be restored; branches belong to the user and to other tasks.
      return has('--') || rest.some((a) => a.includes('/') || a.includes('.'))
        ? allow
        : never('Each task stays on its own branch; switching would build on the wrong one.');
    case 'branch':
      return has('-D', '-d', '--delete', '-m', '-M', '--move', '-f', '--force')
        ? never('Branches belong to the user and to other tasks.')
        : allow;
    case 'worktree':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return never('That rewrites the repository itself.');
    case 'reflog':
      return has('expire', 'delete') ? never('That erases the repository’s safety net.') : allow;
    case 'gc':
      return has('--prune=now', '--aggressive')
        ? never('That erases the repository’s safety net.')
        : allow;
    case 'clean':
      return outsideTargets(rest, ctx)
        ? never('Deleting files outside this task’s checkout.')
        : allow;
    default:
      return allow;
  }
}

/** Arguments that name paths outside the workspace (and outside tmp). */
function outsideTargets(args: string[], ctx: Ctx): boolean {
  return args
    .filter((a) => !a.startsWith('-'))
    .some((arg) => {
      if (arg === '/' || arg === '~' || arg === '*' || /^\/\*?$/.test(arg)) return true;
      if (/^\$(HOME|\{HOME\})/.test(arg)) return true;
      const target = resolve(ctx.cwd, expandHome(arg, ctx.home));
      return !inside(target, ctx.workspace) && !isScratch(target, ctx);
    });
}

function remoteDatabase(segment: string): boolean {
  const hosts = [
    ...segment.matchAll(/(?:-h|--host)[=\s]+([^\s]+)/g),
    ...segment.matchAll(/:\/\/[^@\s]*@?([^:/\s]+)/g),
  ].map((m) => m[1] ?? '');
  return hosts.some(
    (h) => !['localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'postgres'].includes(h),
  );
}

function destructiveSql(segment: string): boolean {
  return /\b(drop\s+(table|database|schema)|truncate\s+|delete\s+from\s+\w+\s*(;|$|")|flushall|flushdb|dropDatabase\(\))/i.test(
    segment,
  );
}

function changesRemote(args: string[]): boolean {
  const method = args.findIndex((a) => a === '-X' || a === '--request');
  const verb = method >= 0 ? (args[method + 1] ?? '').toUpperCase() : '';
  const sendsData = args.some((a) =>
    /^(-d|--data.*|-F|--form|--json|-T|--upload-file|--post-data|--post-file)$/.test(a),
  );
  const url = args.find((a) => /^https?:\/\//.test(a)) ?? '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url);
  return !local && (['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb) || sendsData);
}

/** Split a command line into simple commands: on ;, &&, ||, |, newlines and $(…). */
function segments(command: string): string[] {
  return command
    .replace(/\$\(|`|\)/g, ';')
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shell-ish word splitting: quotes group words; enough to find programs and paths. */
function splitWords(segment: string): string[] {
  const words: string[] = [];
  for (const match of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

/**
 * Scratch space anyone may use: the system temp folders. On macOS Node's
 * tmpdir() is under /var/folders, while tools write to /tmp (really /private/tmp).
 */
function isScratch(target: string, ctx: Ctx): boolean {
  return [ctx.tmp, '/tmp', '/private/tmp', '/var/tmp'].some((dir) => inside(target, dir));
}

function unquote(text: string): string {
  return text.trim().replace(/^["']|["']$/g, '');
}

function expandHome(path: string, home: string): string {
  const native = fromGitBash(path);
  if (native === '~' || native.startsWith('~/')) return home + native.slice(1);
  return native.replace(/^\$\{?HOME\}?/, home);
}

/**
 * On Windows, Claude Code runs commands in Git Bash, which writes C:\Users as
 * /c/Users. Read those as the Windows paths they are, or every absolute path
 * looks like it's outside the task. Exported for tests.
 */
export function fromGitBash(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path;
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(path);
  return drive ? `${drive[1]?.toUpperCase()}:\\${path.slice(3).replace(/\//g, '\\')}` : path;
}

function inside(target: string, dir: string): boolean {
  const rel = relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}
