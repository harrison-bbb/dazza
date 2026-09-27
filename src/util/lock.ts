import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRY_MS = 20;
const TIMEOUT_MS = 10_000;
/** A lock older than this was left behind by a crashed process. */
const STALE_MS = 30_000;

/**
 * Run `work` while holding a lock file, so separate processes (the chat, the
 * builder, each agent's MCP server) never interleave a read-modify-write.
 */
export async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      if (await isStale(path)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
      await sleep(RETRY_MS);
    }
  }
  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * Claim something for as long as this process lives, e.g. the one connection
 * to Slack. Resolves a release function, or undefined if another running
 * process has it. A claim left by a process that has exited is taken over.
 */
export async function claim(path: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (!isExists(error)) throw error;
      const holder = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
      if (isRunning(holder)) return undefined;
      await rm(path, { force: true });
    }
  }
  return undefined;
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it's just not ours to signal.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
