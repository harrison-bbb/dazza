import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
// Loaded only when a screenshot is taken: it's heavy, and most Dazza processes never need it.
import type { Browser } from 'playwright-core';

export type Device = 'desktop' | 'mobile';

export interface CaptureOptions {
  url: string;
  /** Where to write the PNG. */
  file: string;
  device?: Device;
  colorScheme?: 'light' | 'dark';
  /** Capture just this element (with some room around it) instead of the viewport. */
  selector?: string;
  /** Capture the page below the fold too, up to a readable height. */
  fullPage?: boolean;
}

/**
 * Sizes chosen for readability on a phone: a common laptop viewport and a
 * common phone, at high pixel density so text survives Telegram's compression.
 */
const DEVICES = {
  desktop: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
} as const;

/** Tall strips are unreadable on a phone, so full-page shots stop here (in screens). */
const MAX_SCREENS = 3;
const ELEMENT_PADDING = 16;
const SETTLE_MS = 300;
const LOAD_TIMEOUT_MS = 30_000;

/** Freeze motion and hide chrome that makes screenshots look accidental. */
const CLEAN_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important; animation-delay: 0s !important;
    transition: none !important; caret-color: transparent !important;
  }
  ::-webkit-scrollbar { display: none !important; }
`;

/**
 * Takes clean, readable screenshots with the Chrome (or Chromium/Edge) the user
 * already has. One browser is shared across captures and closed with `close()`.
 */
export class Camera {
  private browser: Promise<Browser> | undefined;

  async capture(options: CaptureOptions): Promise<{ width: number; height: number }> {
    const device = DEVICES[options.device ?? 'desktop'];
    const context = await (await this.launch()).newContext({
      ...device,
      colorScheme: options.colorScheme ?? 'light',
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page
        .goto(options.url, { waitUntil: 'networkidle', timeout: LOAD_TIMEOUT_MS })
        .catch(async () => {
          // Some apps keep a connection open forever; settle for the load event.
          await page.goto(options.url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
        });
      await page.addStyleTag({ content: CLEAN_CSS });
      // Evaluated in the page; strings because this module has no DOM types.
      await page.evaluate('document.fonts.ready');
      await page.waitForTimeout(SETTLE_MS);

      await mkdir(dirname(options.file), { recursive: true });
      const { width, height } = device.viewport;

      if (options.selector) {
        const box = await page.locator(options.selector).first().boundingBox();
        if (!box) throw new Error(`Nothing on the page matches ${options.selector}`);
        // The element plus padding, trimmed to the page where it runs off an edge.
        const left = Math.max(0, box.x - ELEMENT_PADDING);
        const top = Math.max(0, box.y - ELEMENT_PADDING);
        const right = Math.min(width, box.x + box.width + ELEMENT_PADDING);
        const bottom = box.y + box.height + ELEMENT_PADDING;
        const clip = { x: left, y: top, width: right - left, height: bottom - top };
        await page.screenshot({ path: options.file, clip, fullPage: true });
        return { width: Math.round(clip.width), height: Math.round(clip.height) };
      }

      if (options.fullPage) {
        const pageHeight = await page.evaluate<number>('document.documentElement.scrollHeight');
        const clipHeight = Math.min(pageHeight, height * MAX_SCREENS);
        await page.screenshot({
          path: options.file,
          fullPage: true,
          clip: { x: 0, y: 0, width, height: clipHeight },
        });
        return { width, height: clipHeight };
      }

      await page.screenshot({ path: options.file });
      return { width, height };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await (await browser?.catch(() => undefined))?.close();
  }

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const executablePath = await findBrowser();
      if (!executablePath) {
        throw new Error(
          'Screenshots need Google Chrome (or Chromium/Edge) installed. ' +
            'Install Chrome, or run `npx playwright install chromium`.',
        );
      }
      const { chromium } = await import('playwright-core');
      return chromium.launch({ executablePath, headless: true });
    })();
    return this.browser;
  }
}

/** A Chromium-based browser already on this machine, if there is one. */
export async function findBrowser(): Promise<string | undefined> {
  const candidates = [
    process.env.DAZZA_BROWSER,
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // Chrome installed for one user, not the whole machine.
    process.env.LOCALAPPDATA &&
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (found) return found;
  // Fall back to a browser installed through Playwright, if any.
  const { chromium } = await import('playwright-core');
  const managed = chromium.executablePath();
  return managed && existsSync(managed) ? managed : undefined;
}
