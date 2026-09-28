import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTreeOnWindows } from '../util/process.js';

/**
 * `!` mode, as in Claude Code: `!npm test` runs in the user's own shell, in the
 * project, without going through Dazza. The output shows as it comes, and a
 * short record of it goes with the next message so Dazza knows what happened.
 */

export interface ShellRun {
  command: string;
  exitCode: number | null;
  /** The last lines of what it printed, for Dazza's context. */
  tail: string;
}

/** Lines of output worth passing on to Dazza. */
const TAIL_LINES = 40;

export async function runShell(
  command: string,
  cwd: string,
  print: (line: string) => void,
  signal: AbortSignal,
): Promise<ShellRun> {
  const child = spawn(command, {
    cwd,
    // The user's own shell, so their aliases and PATH work.
    shell: process.platform === 'win32' ? true : (process.env.SHELL ?? true),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  // Windows has no SIGINT for a child: stop the shell and what it started.
  const stop = () =>
    process.platform === 'win32' && child.pid ? killTreeOnWindows(child.pid) : child.kill('SIGINT');
  signal.addEventListener('abort', stop);
  const tail: string[] = [];
  const read = (stream: NodeJS.ReadableStream) =>
    new Promise<void>((done) => {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => {
        print(line);
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      });
      lines.on('close', done);
    });
  const exited = new Promise<number | null>((done) => {
    child.once('error', () => done(127));
    child.once('close', (code) => done(code));
  });
  await Promise.all([read(child.stdout), read(child.stderr)]);
  const exitCode = await exited;
  signal.removeEventListener('abort', stop);
  return { command, exitCode, tail: tail.join('\n') };
}

/** What Dazza is told about commands the user ran since its last reply. */
export function describeShellRuns(runs: ShellRun[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour codes from output.
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
  return [
    'The user ran these in their own terminal since your last reply (for context, not a request):',
    ...runs.map(
      (run) =>
        `$ ${run.command}  (exit ${run.exitCode ?? 'stopped'})\n${plain(run.tail) || '(no output)'}`,
    ),
  ].join('\n\n');
}
