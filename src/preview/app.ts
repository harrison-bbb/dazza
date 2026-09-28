import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { resolveCommand } from '../util/command.js';

const START_TIMEOUT_MS = 90_000;
const PROBE_INTERVAL_MS = 500;
/** Dev servers print their address; this finds it in their output. */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*/;
const DEV_SCRIPTS = ['dev', 'start', 'preview'];
const STATIC_DIRS = ['.', 'public', 'dist', 'build'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** How to run a project so it can be looked at. */
export type AppLauncher =
  | { type: 'script'; command: string; args: string[]; label: string }
  | { type: 'static'; dir: string };

/**
 * Starts the project's app so it can be screenshotted: its dev script if it has
 * one, otherwise a static server for plain HTML. Started on first use, reused
 * after, and stopped with `stop()` (or when the process exits).
 */
export class AppServer {
  private running: Promise<string> | undefined;
  private child: ChildProcess | undefined;
  private server: Server | undefined;

  constructor(private readonly root: string) {
    process.once('exit', () => this.kill());
  }

  /** The app's base URL, starting it if needed. */
  url(): Promise<string> {
    this.running ??= this.start().catch((error: unknown) => {
      this.running = undefined;
      throw error;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.kill();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    this.server = undefined;
    this.running = undefined;
  }

  private async start(): Promise<string> {
    const launcher = await detectLauncher(this.root);
    if (!launcher) {
      throw new Error(
        'I can’t tell how to run this project: there’s no dev, start or preview script, and no index.html. ' +
          'Start it yourself and pass its url.',
      );
    }
    return launcher.type === 'static' ? this.serveStatic(launcher.dir) : this.runScript(launcher);
  }

  private async runScript(launcher: Extract<AppLauncher, { type: 'script' }>): Promise<string> {
    const port = await freePort();
    const launch = resolveCommand(launcher.command, launcher.args);
    const child = spawn(launch.command, launch.args, {
      ...(launch.shell && { shell: true }),
      cwd: this.root,
      // Most dev servers honour PORT; the rest print whatever port they chose.
      env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // its own process group, so the whole tree stops
    });
    this.child = child;

    let output = '';
    return new Promise<string>((resolvePromise, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        clearInterval(probe);
        fn();
      };
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4000);
        const found = URL_PATTERN.exec(output)?.[0];
        if (found)
          done(() => resolvePromise(found.replace('0.0.0.0', 'localhost').replace(/\/$/, '')));
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) =>
        done(() =>
          reject(
            new Error(
              `${launcher.label} exited (code ${code}) before the app started.\n${tail(output)}`,
            ),
          ),
        ),
      );
      const probe = setInterval(async () => {
        if (await responds(`http://localhost:${port}`))
          done(() => resolvePromise(`http://localhost:${port}`));
      }, PROBE_INTERVAL_MS);
      const timer = setTimeout(
        () =>
          done(() =>
            reject(new Error(`${launcher.label} didn’t start within 90 seconds.\n${tail(output)}`)),
          ),
        START_TIMEOUT_MS,
      );
    });
  }

  private async serveStatic(dir: string): Promise<string> {
    const root = resolve(this.root, dir);
    const server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
      const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
      if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
      try {
        const body = await readFile(file);
        res
          .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
          .end(body);
      } catch {
        res.writeHead(404).end('Not found');
      }
    });
    this.server = server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Static server has no port');
    return `http://localhost:${address.port}`;
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

/** Work out how to run the project: a dev script with its package manager, or static files. */
export async function detectLauncher(root: string): Promise<AppLauncher | undefined> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined);
  if (pkg) {
    const scripts: Record<string, unknown> = JSON.parse(pkg).scripts ?? {};
    const script = DEV_SCRIPTS.find((name) => typeof scripts[name] === 'string');
    if (script) {
      const manager = packageManager(root);
      return {
        type: 'script',
        command: manager,
        args: ['run', script],
        label: `${manager} run ${script}`,
      };
    }
  }
  const dir = STATIC_DIRS.find((d) => existsSync(join(root, d, 'index.html')));
  return dir ? { type: 'static', dir } : undefined;
}

/** The package manager a Node project uses, going by its lockfile. */
export function packageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Whether a Node project's dependencies still need installing before it can run. */
export function needsInstall(root: string): boolean {
  return existsSync(join(root, 'package.json')) && !existsSync(join(root, 'node_modules'));
}

/** Install a Node project's dependencies. Rejects with the tail of the output if it fails. */
export async function installDependencies(root: string): Promise<void> {
  const manager = packageManager(root);
  await new Promise<void>((done, reject) => {
    const launch = resolveCommand(manager, ['install']);
    const child = spawn(launch.command, launch.args, {
      ...(launch.shell && { shell: true }),
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`${manager} install failed.\n${tail(output)}`)),
    );
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function responds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function tail(output: string): string {
  return output.trim().split('\n').slice(-8).join('\n');
}
