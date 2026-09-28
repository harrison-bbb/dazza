import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeShellRuns, runShell } from '../../src/chat/shell.js';
import { useTempProject } from '../helpers.js';

const WIN = process.platform === 'win32';

describe('! mode', () => {
  const project = useTempProject();

  it('runs the user’s own command in the project, showing output as it comes', async () => {
    const printed: string[] = [];
    const run = await runShell(
      `echo hello && ${WIN ? 'cd' : 'pwd'} && exit 3`,
      project.root,
      (line) => printed.push(line),
      new AbortController().signal,
    );
    // cmd.exe keeps the space before &&.
    expect(printed[0]?.trimEnd()).toBe('hello');
    expect(printed[1]).toContain(basename(project.root));
    expect(run.exitCode).toBe(3);
    expect(describeShellRuns([run])).toContain('  (exit 3)\nhello');
  });

  it('stops on Ctrl-C', async () => {
    const stop = new AbortController();
    const running = runShell(
      WIN ? 'ping -n 6 127.0.0.1 > nul' : 'sleep 5',
      project.root,
      () => {},
      stop.signal,
    );
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    await running;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
