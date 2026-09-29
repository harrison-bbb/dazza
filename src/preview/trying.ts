import { existsSync } from 'node:fs';
import type { Store } from '../core/store.js';
import { openInBrowser } from '../util/open.js';
import { errorMessage } from '../util/text.js';
import {
  AppServer,
  detectLauncher,
  installDependencies,
  needsInstall,
  packageManager,
} from './app.js';

/**
 * Trying a task's work: start it and open it in the browser, from `/try` in
 * the terminal or the Try it button on the board. One app at a time, so ports
 * and processes don't pile up; trying another stops the last.
 */

export type TryResult =
  | { ok: true; taskId: string; url: string }
  | { ok: false; message: string; needsInstall?: { command: string; dir: string } };

let trying: { taskId: string; url: string; app: AppServer } | undefined;
/**
 * A start under way: one at a time, claimed before anything is awaited, so a
 * second click (another board tab, /try at the same moment) can't start a
 * second install in the same folder. `cancelled` is a stop that came meanwhile.
 */
let starting: { taskId: string; cancelled: boolean } | undefined;

export interface TryOptions {
  /** Install dependencies if they're missing, without asking (the board's button says it will). */
  install?: boolean;
  /** Progress, e.g. "Installing T3's dependencies…". */
  status?: (text: string | undefined) => void;
}

export async function tryTask(
  store: Store,
  taskId: string,
  options: TryOptions = {},
): Promise<TryResult> {
  if (starting)
    return { ok: false, message: `Already starting ${starting.taskId}. Give it a moment.` };
  const claim = { taskId, cancelled: false };
  starting = claim;
  try {
    const task = (await store.readPlan())?.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, message: `No task ${taskId}.` };
    if (task.status !== 'review' && task.status !== 'closed') {
      return {
        ok: false,
        message:
          task.status === 'building'
            ? `${task.id} is being built right now. Try it once it’s ready for review.`
            : `${task.id} hasn’t been built yet.`,
      };
    }
    // Approved work is merged, so it runs from the user's own checkout.
    const dir = task.status === 'closed' ? store.root : (await store.readTaskBuild(task.id))?.dir;
    if (!dir || !existsSync(dir))
      return { ok: false, message: `${task.id} hasn’t been built yet.` };
    if (!(await detectLauncher(dir))) {
      return {
        ok: false,
        message: `I can’t tell how to run ${task.id}’s work: there’s no dev or start script and no index.html. Its handoff says how to check it.`,
      };
    }
    if (needsInstall(dir)) {
      const command = `${packageManager(dir)} install`;
      if (!options.install) return { ok: false, message: '', needsInstall: { command, dir } };
      options.status?.(`Installing ${task.id}’s dependencies…`);
      try {
        await installDependencies(dir);
      } catch (error) {
        return { ok: false, message: `Couldn’t install its dependencies: ${errorMessage(error)}` };
      }
    }
    if (claim.cancelled) return { ok: false, message: `Stopped before ${task.id} started.` };
    await stopRunning(); // the last one tried, not this start
    const app = new AppServer(dir);
    options.status?.(`Starting ${task.id}…`);
    try {
      const url = await app.url();
      if (claim.cancelled) {
        await app.stop();
        return { ok: false, message: `Stopped before ${task.id} opened.` };
      }
      trying = { taskId: task.id, url, app };
      openInBrowser(url);
      return { ok: true, taskId: task.id, url };
    } catch (error) {
      await app.stop();
      return { ok: false, message: `${task.id} didn’t start: ${errorMessage(error)}` };
    }
  } finally {
    if (starting === claim) starting = undefined;
    options.status?.(undefined);
  }
}

/**
 * Stop the app being tried, or one still starting. Resolves the task it was
 * for, if there was one.
 */
export async function stopTrying(): Promise<string | undefined> {
  const was = await stopRunning();
  if (!was && starting && !starting.cancelled) {
    starting.cancelled = true;
    return starting.taskId;
  }
  return was;
}

async function stopRunning(): Promise<string | undefined> {
  const was = trying;
  trying = undefined;
  await was?.app.stop();
  return was?.taskId;
}

/** The app running now, if any. */
export function tryingNow(): { taskId: string; url: string } | undefined {
  return trying && { taskId: trying.taskId, url: trying.url };
}
