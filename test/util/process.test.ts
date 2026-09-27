import { describe, expect, it } from 'vitest';
import { CommandError, execCommand, spawnLines } from '../../src/util/process.js';

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
