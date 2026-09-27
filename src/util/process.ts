import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
): Promise<CommandResult | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args);
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
  signal?: AbortSignal;
}

/**
 * Spawn a long-running command and yield its stdout line by line.
 * Throws `CommandError` if it exits non-zero. Stopping iteration early kills the process.
 */
export async function* spawnLines(
  command: string,
  args: readonly string[],
  options: SpawnLinesOptions,
): AsyncGenerator<string> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.signal && { signal: options.signal }),
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      yield line;
    }
    const exitCode = await exited;
    if (exitCode !== 0) throw new CommandError(command, exitCode, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isExecError(error: unknown): error is Error & CommandResult & { code: number } {
  return error instanceof Error && 'code' in error && typeof error.code === 'number';
}
