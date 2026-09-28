import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import { parseJson } from '../util/text.js';

/**
 * Building on after the terminal closes, when the user has switched it on
 * (`/background on`). The terminal's Dazza hands the build to a background
 * Dazza on the same machine, which keeps building, messaging and serving the
 * board until the work runs out, it's been idle for hours, or the user stops
 * it: `dazza stop`, "stop" from their phone, or opening `dazza` again (which
 * takes the build back into the terminal).
 */

const STATE_FILE = 'background.json';
const LOG_FILE = 'background.log';
/** Give up on a build nothing's happened in for this long. */
export const IDLE_LIMIT_MS = 12 * 60 * 60_000;
/** How long `dazza stop` (or taking over) waits for the background build to pause. */
const STOP_WAIT_MS = 30_000;

const BackgroundState = z.object({ pid: z.number().int(), startedAt: z.string() });
export type BackgroundState = z.infer<typeof BackgroundState>;

/** The background build running for this project, if there is one. */
export async function runningInBackground(store: Store): Promise<BackgroundState | undefined> {
  const raw = await readFile(join(store.dir, STATE_FILE), 'utf8').catch(() => undefined);
  const parsed = BackgroundState.safeParse(parseJson(raw));
  if (!parsed.success) return undefined;
  return isAlive(parsed.data.pid) ? parsed.data : undefined;
}

/** Hand the build to a background Dazza, detached from this terminal. */
export function startInBackground(root: string, store: Store, cli: string): void {
  const log = openSync(join(store.dir, LOG_FILE), 'a');
  const child = spawn(process.execPath, [cli, '--background'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, DAZZA_NO_BROWSER: '1' },
  });
  child.unref();
}

/** Stop the background build (it pauses its task), waiting until it's gone. */
export async function stopInBackground(store: Store): Promise<boolean> {
  const running = await runningInBackground(store);
  if (!running) return false;
  try {
    process.kill(running.pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (isAlive(running.pid) && Date.now() < deadline) await sleep(200);
  return true;
}

/** Called by the background Dazza itself: it's running, so others can find and stop it. */
export async function markRunning(store: Store): Promise<() => Promise<void>> {
  const state: BackgroundState = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(join(store.dir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // On a Mac, keep it from going to sleep while there's work (closing the lid still does).
  if (process.platform === 'darwin') {
    const awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    });
    awake.on('error', () => {});
    awake.unref();
  }
  return () => rm(join(store.dir, STATE_FILE), { force: true });
}

export interface BackgroundWork {
  /** Building, or waiting to pick the build back up (an answer, a review). */
  onTheJob(): boolean;
  /** Everything is closed or cancelled: nothing left to build. */
  allDone(): Promise<boolean>;
  /** When anything last happened in the project. */
  lastActivity(): Promise<number>;
}

/**
 * Keep the background build alive until there's a reason to stop, and say
 * what it was.
 */
export function waitInBackground(work: BackgroundWork, checkEveryMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    const finish = (reason: string) => {
      clearInterval(timer);
      process.off('SIGTERM', stopped);
      resolve(reason);
    };
    const stopped = () => finish('you stopped it');
    process.once('SIGTERM', stopped);
    const timer = setInterval(async () => {
      if (!work.onTheJob()) return finish('the build was stopped');
      if (await work.allDone()) return finish('everything is built');
      if (Date.now() - (await work.lastActivity()) > IDLE_LIMIT_MS) {
        finish('nothing has happened for 12 hours');
      }
    }, checkEveryMs);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
