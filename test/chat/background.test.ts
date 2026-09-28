import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runningInBackground,
  stopInBackground,
  waitInBackground,
} from '../../src/chat/background.js';
import { useTempProject } from '../helpers.js';

describe('building in the background', () => {
  const project = useTempProject();
  const work = (overrides: Partial<Parameters<typeof waitInBackground>[0]> = {}) => ({
    onTheJob: () => true,
    allDone: async () => false,
    lastActivity: async () => Date.now(),
    ...overrides,
  });

  it('keeps going until the build is stopped, everything is built, or the user stops it', async () => {
    expect(await waitInBackground(work({ onTheJob: () => false }), 10)).toBe(
      'the build was stopped',
    );
    expect(await waitInBackground(work({ allDone: async () => true }), 10)).toBe(
      'everything is built',
    );
    expect(
      await waitInBackground(work({ lastActivity: async () => Date.now() - 13 * 60 * 60_000 }), 10),
    ).toBe('nothing has happened for 12 hours');
    const waiting = waitInBackground(work(), 1_000);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await waiting).toBe('you stopped it');
  });

  it('is found and stopped by `dazza stop`, from any terminal', async () => {
    expect(await runningInBackground(project.store)).toBeUndefined();
    expect(await stopInBackground(project.store)).toBe(false);

    // A stand-in background build: it pauses (exits) when asked to stop.
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await project.store.init();
    await writeFile(
      join(project.store.dir, 'background.json'),
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
    );
    expect((await runningInBackground(project.store))?.pid).toBe(child.pid);
    expect(await stopInBackground(project.store)).toBe(true);
    expect(await runningInBackground(project.store)).toBeUndefined();
  });
});
