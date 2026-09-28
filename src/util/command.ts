import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * How to start a program by name, on any platform.
 *
 * On macOS and Linux the name is enough. On Windows it often isn't: npm
 * installs CLIs like `claude` and `codex` as `.cmd` wrapper scripts, and Node
 * only finds `.exe`/`.com` files by bare name, and won't run a `.cmd` without
 * a shell. Going through `cmd.exe` mangles the long, multi-line arguments Dazza
 * passes (system prompts, JSON), so a wrapper npm wrote is read instead, and
 * the script it launches is run with Node directly.
 */
export interface Launch {
  command: string;
  args: string[];
  /** Only for scripts that can't be unwrapped; fine for simple arguments. */
  shell?: boolean;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string | undefined;
  nodePath?: string;
}

export function resolveCommand(
  command: string,
  args: readonly string[],
  options: ResolveOptions = {},
): Launch {
  const { platform = process.platform, env = process.env } = options;
  if (platform !== 'win32') return { command, args: [...args] };

  const isFile = options.isFile ?? fileExists;
  const readText = options.readText ?? readTextFile;
  const found = findOnPath(command, env, isFile);
  if (!found) return { command, args: [...args] }; // not installed: let it fail as usual

  const ext = win32.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: found, args: [...args] };
  if (ext === '.cmd' || ext === '.bat') {
    const target = shimTarget(found, readText);
    if (target) {
      const targetExt = win32.extname(target).toLowerCase();
      return targetExt === '.exe' || targetExt === '.com'
        ? { command: target, args: [...args] }
        : { command: options.nodePath ?? process.execPath, args: [target, ...args] };
    }
  }
  return { command: found, args: [...args], shell: true };
}

/** The file `name` runs as on Windows: the first PATH match, trying PATHEXT's extensions. */
function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
): string | undefined {
  // Windows environment names aren't case sensitive, but a copied env object is.
  const get = (key: string) =>
    Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] ?? '';
  const exts = (get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (base: string) =>
    win32.extname(base) ? [base] : exts.map((ext) => `${base}${ext.toLowerCase()}`);
  if (/[\\/]/.test(name)) return candidates(name).find(isFile);
  for (const dir of get('PATH').split(';').filter(Boolean)) {
    const hit = candidates(win32.join(dir.replace(/^"|"$/g, ''), name)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The script an npm (or pnpm, or yarn) `.cmd` wrapper launches, e.g.
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"`, as a full path.
 */
function shimTarget(
  shim: string,
  readText: (path: string) => string | undefined,
): string | undefined {
  const text = readText(shim);
  if (!text) return undefined;
  // The script it runs; failing that, a program it runs. Not node.exe itself,
  // which npm's wrappers mention first.
  const target = [...text.matchAll(/"%~?dp0%?\\([^"%]+?)"/gi)]
    .map((m) => m[1] ?? '')
    .sort((a, b) => rank(a) - rank(b))
    .find((path) => rank(path) < 2);
  return target ? win32.join(win32.dirname(shim), target) : undefined;
}

/** 0 for a script, 1 for another program, 2 for anything else (node.exe included). */
function rank(path: string): number {
  if (/\.(c|m)?js$/i.test(path)) return 0;
  if (/\.exe$/i.test(path) && !/(^|\\)node\.exe$/i.test(path)) return 1;
  return 2;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
