import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { shownPath } from '../util/paths.js';
import type { MenuItem, MenuSource } from './editor.js';

/**
 * Pointing Dazza at things, as in Claude Code: `@src/app.ts` mentions a file
 * (with a menu of the project's files as you type), and screenshots come in by
 * pasting (Ctrl+V) or dragging an image into the terminal.
 */

const SKIP = new Set([
  'node_modules',
  '.git',
  '.dazza',
  'dist',
  'build',
  '.next',
  'coverage',
  'target',
  'vendor',
]);
const MAX_FILES = 5_000;
const MENU_SIZE = 8;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** The project's files, relative to its root, for the @ menu. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(path);
      } else if (entry.isFile() && found.length < MAX_FILES) {
        found.push(shownPath(root, path));
      }
    }
  };
  await walk(root);
  return found.sort();
}

/** The @ menu: files matching what's typed after the last @, best matches first. */
export function fileMenu(files: () => readonly string[]): MenuSource {
  return (text) => {
    const typed = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1];
    if (typed === undefined) return [];
    const query = typed.toLowerCase();
    const before = text.slice(0, text.length - typed.length);
    const name = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return files()
      .filter((path) => path.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(!name(a).startsWith(query)) - Number(!name(b).startsWith(query)) ||
          a.length - b.length,
      )
      .slice(0, MENU_SIZE)
      .map(
        (path): MenuItem => ({
          value: `${before}${path}`,
          label: `@${path}`,
          hint: '',
          insert: true,
        }),
      );
  };
}

/**
 * A note for Dazza naming what the message points at: files mentioned with @,
 * and image or file paths pasted in (a dragged-in screenshot arrives as its path).
 */
export function pointedAt(message: string, root: string): string | undefined {
  const mentioned = [...message.matchAll(/(?:^|\s)@([^\s@]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((path) => existsSync(resolve(root, path)));
  const pasted = [
    // macOS and Linux terminals paste '/a/b.png' or /a/b\ c.png; Windows ones "C:\a\b.png".
    ...message.matchAll(
      /(?:^|\s)['"]?((?:\/|[A-Za-z]:[\\/])[^\n'"]*?\.[A-Za-z0-9]{1,5})['"]?(?=\s|$)/g,
    ),
  ]
    .map((m) => m[1] ?? '')
    .map((path) => (path.startsWith('/') ? path.replace(/\\ /g, ' ') : path))
    .filter((path) => isAbsolute(path) && isFile(path));
  const all = [...new Set([...mentioned, ...pasted])];
  if (all.length === 0) return undefined;
  const images = all.filter((path) => IMAGE.test(path));
  return [
    `The user pointed at: ${all.join(', ')}.`,
    images.length > 0
      ? 'Look at the images (open them with your file reader) before you answer.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/**
 * The image on the clipboard, saved as a PNG under `dir`; undefined when there
 * isn't one (or no way to read it on this machine).
 */
export async function pasteClipboardImage(dir: string): Promise<string | undefined> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `pasted-${Date.now()}.png`);
  const attempts: [string, string[]][] =
    process.platform === 'darwin'
      ? [
          [
            'osascript',
            [
              '-e',
              'set png to (the clipboard as «class PNGf»)',
              '-e',
              `set f to open for access (POSIX file "${file}") with write permission`,
              '-e',
              'write png to f',
              '-e',
              'close access f',
            ],
          ],
        ]
      : process.platform === 'win32'
        ? [
            [
              'powershell',
              [
                '-NoProfile',
                '-Command',
                `Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${file}') } else { exit 1 }`,
              ],
            ],
          ]
        : [
            ['sh', ['-c', `wl-paste --type image/png > '${file}'`]],
            ['sh', ['-c', `xclip -selection clipboard -t image/png -o > '${file}'`]],
          ];
  for (const [command, args] of attempts) {
    const ok = await execFileAsync(command, args).then(
      () => true,
      () => false,
    );
    if (ok && isFile(file) && statSync(file).size > 0) return file;
  }
  return undefined;
}
