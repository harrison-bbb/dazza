import { describe, expect, it } from 'vitest';
import { describeShellRuns, runShell } from '../../src/chat/shell.js';
import { useTempProject } from '../helpers.js';

describe('! mode', () => {
  const project = useTempProject();

  it('runs the user’s own command in the project, showing output as it comes', async () => {
    const printed: string[] = [];
    const run = await runShell(
      'echo hello && pwd && exit 3',
      project.root,
      (line) => printed.push(line),
      new AbortController().signal,
    );
    expect(printed[0]).toBe('hello');
    expect(printed[1]).toContain(project.root.split('/').at(-1));
    expect(run.exitCode).toBe(3);
    expect(describeShellRuns([run])).toContain('$ echo hello && pwd && exit 3  (exit 3)\nhello');
  });

  it('stops on Ctrl-C', async () => {
    const stop = new AbortController();
    const running = runShell('sleep 5', project.root, () => {}, stop.signal);
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    await running;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
