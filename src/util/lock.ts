import { open, rm, stat } from 'node:fs/promises';
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
