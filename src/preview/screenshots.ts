import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import { AppServer } from './app.js';
import { Camera } from './capture.js';

export const ScreenshotRequest = z.object({
  taskId: z
    .string()
    .optional()
    .describe('The task it’s for. Leave out for the project as a whole.'),
  name: z.string().min(1).describe('A short name, e.g. "login-page" or "header-overlap".'),
  path: z
    .string()
    .optional()
    .describe('The page to open, e.g. "/login". Dazza starts the app if it isn’t running.'),
  url: z
    .string()
    .optional()
    .describe('A full URL instead, if the app is already running somewhere.'),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  colorScheme: z.enum(['light', 'dark']).default('light'),
  selector: z
    .string()
    .optional()
    .describe('A CSS selector to capture just one element, e.g. the component with an issue.'),
  fullPage: z.boolean().default(false).describe('Include below the fold (up to three screens).'),
});
export type ScreenshotRequest = z.input<typeof ScreenshotRequest>;

/**
 * Screenshots of the project's app, saved under `.dazza/media/<task>/`. Starts
 * the app when needed and keeps it (and the browser) running for later shots.
 */
export class Screenshots {
  private readonly camera = new Camera();
  private app: Promise<AppServer> | undefined;

  constructor(
    private readonly store: Store,
    /** The directory the app runs from; decided at the first screenshot. */
    private readonly root: () => Promise<string> = async () => store.root,
  ) {}

  /** Take a screenshot; resolves to its media path, e.g. "T3/login-page-desktop.png". */
  async take(input: ScreenshotRequest): Promise<{ path: string; width: number; height: number }> {
    const request = ScreenshotRequest.parse(input);
    this.app ??= this.root().then((root) => new AppServer(root));
    const url =
      request.url ?? new URL(request.path ?? '/', `${await (await this.app).url()}/`).toString();
    const scope = request.taskId?.split('.')[0] ?? 'project';
    // The device is added to the name, so drop it if the caller already included it.
    const name = slug(request.name).replace(/-(desktop|mobile)$/, '');
    const path = await this.freePath(scope, `${name}-${request.device}`);

    const size = await this.camera.capture({
      url,
      file: this.store.mediaFile(path),
      device: request.device,
      colorScheme: request.colorScheme,
      fullPage: request.fullPage,
      ...(request.selector && { selector: request.selector }),
    });
    return { path, ...size };
  }

  async close(): Promise<void> {
    await Promise.all([this.camera.close(), this.app?.then((app) => app.stop())]);
  }

  /** A path that doesn't overwrite an earlier screenshot: name.png, name-2.png, … */
  private async freePath(scope: string, base: string): Promise<string> {
    const existing = new Set(
      await readdir(dirname(this.store.mediaFile(`${scope}/x.png`))).catch(() => []),
    );
    for (let n = 1; ; n++) {
      const file = n === 1 ? `${base}.png` : `${base}-${n}.png`;
      if (!existing.has(file)) return `${scope}/${file}`;
    }
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'screenshot'
  );
}
