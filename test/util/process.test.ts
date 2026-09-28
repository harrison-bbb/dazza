import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CommandError,
  execCommand,
  procStart,
  spawnLines,
  stopProcessesIn,
} from '../../src/util/process.js';

const node = process.execPath;
const cwd = process.cwd();

describe('execCommand', () => {
  it('captures output and non-zero exits', async () => {
    const result = await execCommand(node, ['-e', 'console.log("out"); process.exit(3)']);
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n' });
  });

  it('returns undefined for a missing binary', async () => {
    expect(await execCommand('dazza-no-such-binary', [])).toBeUndefined();
  });
});

describe('spawnLines', () => {
  it('yields stdout line by line', async () => {
    const lines: string[] = [];
    for await (const line of spawnLines(node, ['-e', 'console.log("a\\nb")'], { cwd })) {
      lines.push(line);
    }
    expect(lines).toEqual(['a', 'b']);
  });

  it('throws CommandError on a non-zero exit', async () => {
    const run = async () => {
      for await (const _ of spawnLines(node, ['-e', 'process.exit(1)'], { cwd })) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(CommandError);
  });

  it('kills the process when the consumer stops early', async () => {
    const script = 'setInterval(() => console.log("tick"), 5)';
    for await (const line of spawnLines(node, ['-e', script], { cwd })) {
      expect(line).toBe('tick');
      break;
    }
    // Reaching here without hanging means the child was killed.
  });

  it('writes input to stdin', async () => {
    const script = 'process.stdin.pipe(process.stdout)';
    const lines: string[] = [];
    for await (const line of spawnLines(node, ['-e', script], { cwd, input: 'from stdin' })) {
      lines.push(line);
    }
    expect(lines).toEqual(['from stdin']);
  });
});

describe('spawnLines abort', () => {
  it('rejects cleanly when aborted mid-stream, without an unhandled rejection', async () => {
    const controller = new AbortController();
    const script = 'console.log("start"); setInterval(() => {}, 1000)';
    const run = async () => {
      for await (const _ of spawnLines(node, ['-e', script], { cwd, signal: controller.signal })) {
        controller.abort();
      }
    };
    await expect(run()).rejects.toThrow(/abort/i);
  });

  it('stops the whole tree on abort, including what the process started', async () => {
    // The child starts a grandchild (think: a dev server) and reports its pid.
    const script = `
      const { spawn } = require('node:child_process');
      const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(kid.pid);
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    let grandchild = 0;
    const run = async () => {
      for await (const line of spawnLines(node, ['-e', script], {
        cwd,
        signal: controller.signal,
      })) {
        grandchild = Number(line);
        controller.abort();
      }
    };
    await run().catch(() => {});
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(grandchild).toBeGreaterThan(0);
    expect(alive()).toBe(false);
  });
});

describe('stopProcessesIn', () => {
  it('stops what was started in a folder during the run, and leaves older processes alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dazza-stray-'));
    // A script in the folder: on Windows, Dazza finds strays by what they run, not their cwd.
    const script = join(dir, 'idle.js');
    await writeFile(script, 'setInterval(() => {}, 1000)');
    const idle = [script];
    const older = spawn(node, idle, { cwd: dir, detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500)); // ps start times are to the second
    const since = new Date();
    const stray = spawn(node, idle, { cwd: dir, detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    const stopped = await stopProcessesIn(dir, since);
    expect(stopped).toEqual([stray.pid]);
    const gone = () => stray.exitCode !== null || stray.signalCode !== null;
    for (let i = 0; i < 50 && !gone(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(stray.exitCode !== null || stray.signalCode !== null).toBe(true);
    expect(older.exitCode).toBeNull();
    older.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});

describe('procStart', () => {
  it('reads a Linux process’s start time from /proc, even with an awkward command name', () => {
    // pid (comm) state ppid ... field 22 = starttime, in clock ticks after boot.
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    fields[19] = '12345'; // starttime: 123.45s after boot
    const stat = `4242 (node (dev) server) ${fields.join(' ')}`;
    expect(procStart(stat, 1_790_000_000)).toBe((1_790_000_000 + 123.45) * 1000);
    expect(procStart('', 1_790_000_000)).toBeUndefined();
  });
});
