import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { resolveCommand } from './command.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 64 * 1024 * 1024;

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'CommandError';
  }
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion. Resolves with its output even on a non-zero exit;
 * resolves `undefined` if the binary is not installed.
 */
export async function execCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<CommandResult | undefined> {
  try {
    const launch = resolveCommand(command, args, env && { env });
    // Big diffs and file lists outgrow the 1 MB default.
    const { stdout, stderr } = await execFileAsync(launch.command, launch.args, {
      ...(launch.shell && { shell: true }),
      maxBuffer: MAX_OUTPUT,
      ...(env && { env }),
      ...(cwd && { cwd }),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    if (isExecError(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

export interface SpawnLinesOptions {
  cwd: string;
  /** Written to the process's stdin, which is then closed (unless `keepStdinOpen`). */
  input?: string;
  /** For conversational processes that exit when stdin closes; stopped via the signal. */
  keepStdinOpen?: boolean;
  /** The child's whole environment; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Spawn a long-running command and yield its stdout line by line.
 * Throws `CommandError` if it exits non-zero. Stopping iteration early, or the
 * signal, stops the process and everything it started: an agent's dev servers
 * and test watchers run in its process group, and go with it.
 */
export async function* spawnLines(
  command: string,
  args: readonly string[],
  options: SpawnLinesOptions,
): AsyncGenerator<string> {
  const launch = resolveCommand(command, args, options.env && { env: options.env });
  const child = spawn(launch.command, launch.args, {
    ...(launch.shell && { shell: true }),
    cwd: options.cwd,
    stdio: 'pipe',
    // Its own process group, so the whole tree can be stopped together.
    detached: GROUPS,
    ...(options.env && { env: options.env }),
  });
  const stop = () => stopTree(child);
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener('abort', stop);
  if (child.pid) running.add(child.pid);
  if (options.keepStdinOpen) child.stdin.write(options.input ?? '');
  else child.stdin.end(options.input);

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // An abort can reject this while we're still reading output; it's awaited (and
  // rethrown) below, so don't let Node treat it as an unhandled rejection meanwhile.
  exited.catch(() => {});

  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      yield line;
    }
    const exitCode = await exited;
    // Stopped on purpose: say so, rather than reporting the kill as a failure.
    options.signal?.throwIfAborted();
    if (exitCode !== 0) throw new CommandError(command, exitCode, stderr);
  } finally {
    options.signal?.removeEventListener('abort', stop);
    if (child.exitCode === null) stop();
    if (child.pid) running.delete(child.pid);
  }
}

/** Process groups are a POSIX thing; on Windows, kill the process itself. */
const GROUPS = process.platform !== 'win32';
/** Give a process tree this long to stop politely before it's killed. */
const KILL_AFTER_MS = 3_000;
/** Groups still running, stopped if Dazza exits first. */
const running = new Set<number>();
process.once('exit', () => {
  for (const pid of running) signalTree(pid, 'SIGKILL');
});

function stopTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  const pid = child.pid;
  signalTree(pid, 'SIGTERM');
  setTimeout(() => signalTree(pid, 'SIGKILL'), KILL_AFTER_MS).unref();
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(GROUPS ? -pid : pid, signal);
  } catch {
    // Already gone.
  }
}

/** Run a command attached to this terminal, for interactive steps like signing in. */
export function runInteractive(command: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const launch = resolveCommand(command, args);
    const child = spawn(launch.command, launch.args, {
      stdio: 'inherit',
      ...(launch.shell && { shell: true }),
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isExecError(error: unknown): error is Error & CommandResult & { code: number } {
  return error instanceof Error && 'code' in error && typeof error.code === 'number';
}

/**
 * Stop processes running from inside `dir` that started after `since`: what an
 * agent left behind in its worktree, like a dev server it started in the
 * background. Agent CLIs run each shell command in its own process group, so
 * stopping the agent's group doesn't reach these. Anything started before the
 * run (the user trying the work in that folder, say) is left alone.
 * Resolves the pids stopped.
 */
export async function stopProcessesIn(dir: string, since: Date): Promise<number[]> {
  const roots = [dir, await realpath(dir).catch(() => dir)];
  const inDir = (path: string) =>
    roots.some((root) => path === root || path.startsWith(`${root}/`));
  const pids = (await workingDirectories())
    .filter(({ pid, cwd }) => pid !== process.pid && inDir(cwd))
    .map(({ pid }) => pid);
  const started = await startTimes(pids);
  const stray = pids.filter((pid) => (started.get(pid) ?? 0) >= since.getTime() - START_SLACK_MS);
  for (const pid of stray) {
    signal(pid, 'SIGTERM');
    setTimeout(() => signal(pid, 'SIGKILL'), KILL_AFTER_MS).unref();
  }
  return stray;
}

/** `ps` start times are to the second. */
const START_SLACK_MS = 1_000;

/** Every process's working directory. */
async function workingDirectories(): Promise<{ pid: number; cwd: string }[]> {
  if (process.platform === 'linux') {
    const entries = await readdir('/proc').catch(() => []);
    const found = await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map(async (e) => ({
          pid: Number(e),
          cwd: await readlink(`/proc/${e}/cwd`).catch(() => ''),
        })),
    );
    return found.filter((p) => p.cwd);
  }
  // macOS and the BSDs: lsof reports each process's cwd as "p<pid>" then "n<path>".
  const result = await execCommand('lsof', ['-d', 'cwd', '-Fpn']);
  const found: { pid: number; cwd: string }[] = [];
  let pid = 0;
  for (const line of result?.stdout.split('\n') ?? []) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) found.push({ pid, cwd: line.slice(1) });
  }
  return found;
}

async function startTimes(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  // Linux: straight from the kernel, so it works without a full `ps` (BusyBox has no lstart).
  if (process.platform === 'linux') {
    const fromProc = await procStartTimes(pids);
    if (fromProc.size > 0) return fromProc;
  }
  const result = await execCommand('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')]);
  const times = new Map<number, number>();
  for (const line of result?.stdout.split('\n') ?? []) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match?.[1] && match[2]) times.set(Number(match[1]), Date.parse(match[2]));
  }
  return times;
}

/**
 * When each process started, from /proc: its start time in clock ticks after
 * boot (field 22 of /proc/<pid>/stat), plus the boot time from /proc/stat.
 */
async function procStartTimes(pids: number[]): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  const boot = Number(
    /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8').catch(() => ''))?.[1],
  );
  if (!boot) return times;
  for (const pid of pids) {
    const started = procStart(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''), boot);
    if (started !== undefined) times.set(pid, started);
  }
  return times;
}

/** A process's start, in ms since the epoch, from its /proc/<pid>/stat line. Exported for tests. */
export function procStart(stat: string, bootSeconds: number): number | undefined {
  // The command name (field 2) can hold spaces and brackets: count fields after its closing ")".
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Field 22 (starttime) is the 20th after the name.
  const ticks = Number(fields[19]);
  return fields.length > 19 && Number.isFinite(ticks)
    ? (bootSeconds + ticks / CLOCK_TICKS) * 1000
    : undefined;
}

/** Linux's clock ticks per second (USER_HZ): 100 on every mainstream kernel. */
const CLOCK_TICKS = 100;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * A command and its arguments as one line for a shell, quoted where needed.
 * On Windows, double quotes, which both bash and cmd.exe read the same way for
 * paths like C:\Program Files\nodejs\node.exe.
 */
export function shellCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote =
    platform === 'win32'
      ? (word: string) => `"${word.replace(/"/g, '\\"')}"`
      : (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
  return [command, ...args]
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : quote(word)))
    .join(' ');
}
