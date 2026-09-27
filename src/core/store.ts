import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Event, Plan } from './schema.js';

export const STATE_DIR = '.dazza';

const MANAGER_SESSION_FILE = 'session.json';
const LOCAL_FILES = [MANAGER_SESSION_FILE];

const ManagerSession = z.object({ sessionId: z.string() });

/**
 * File-backed project state. Everything lives in `<root>/.dazza/` as plain,
 * human-readable files so the board, CLI and bot are just views over it.
 */
export class Store {
  readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, STATE_DIR);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Machine-local state stays out of git; everything else is meant to be committed.
    await writeFile(this.path('.gitignore'), `${LOCAL_FILES.join('\n')}\n`, 'utf8');
  }

  async readPlan(): Promise<Plan | undefined> {
    const raw = await this.readOptional('tasks.json');
    return raw === undefined ? undefined : Plan.parse(JSON.parse(raw));
  }

  async writePlan(plan: Plan): Promise<void> {
    await this.writeAtomic('tasks.json', `${JSON.stringify(Plan.parse(plan), null, 2)}\n`);
  }

  async readScope(): Promise<string | undefined> {
    return this.readOptional('scope.md');
  }

  async writeScope(markdown: string): Promise<void> {
    await this.writeAtomic('scope.md', markdown);
  }

  /** The manager conversation's agent session, so `dazza` picks up where it left off. */
  async readManagerSession(): Promise<string | undefined> {
    const raw = await this.readOptional(MANAGER_SESSION_FILE);
    return raw === undefined ? undefined : ManagerSession.parse(JSON.parse(raw)).sessionId;
  }

  async writeManagerSession(sessionId: string): Promise<void> {
    await this.writeAtomic(MANAGER_SESSION_FILE, `${JSON.stringify({ sessionId }, null, 2)}\n`);
  }

  async appendEvent(event: Event): Promise<void> {
    await this.init();
    await appendFile(this.path('events.jsonl'), `${JSON.stringify(Event.parse(event))}\n`);
  }

  async readEvents(): Promise<Event[]> {
    const raw = await this.readOptional('events.jsonl');
    if (raw === undefined) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => Event.parse(JSON.parse(line)));
  }

  private path(file: string): string {
    return join(this.dir, file);
  }

  private async readOptional(file: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(file), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Write via temp file + rename so readers never observe a half-written file. */
  private async writeAtomic(file: string, contents: string): Promise<void> {
    await this.init();
    const target = this.path(file);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, contents, 'utf8');
    await rename(temp, target);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
