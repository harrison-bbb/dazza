import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServer, detectLauncher } from '../../src/preview/app.js';
import { Camera, findBrowser } from '../../src/preview/capture.js';
import { useTempProject } from '../helpers.js';

const page = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px system-ui; }
  header { height: 60px; background: #222; color: #fff; }
  .tall { height: 5000px; }
</style></head><body><header id="top">Hello</header><div class="tall"></div></body></html>`;

/** Width and height from a PNG's header. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('detectLauncher', () => {
  const project = useTempProject();

  it('prefers a dev script, run with the project’s package manager', async () => {
    await writeFile(
      join(project.root, 'package.json'),
      JSON.stringify({ scripts: { start: 'x', dev: 'y' } }),
    );
    await writeFile(join(project.root, 'pnpm-lock.yaml'), '');
    expect(await detectLauncher(project.root)).toMatchObject({
      command: 'pnpm',
      args: ['run', 'dev'],
    });
  });

  it('falls back to static HTML, then gives up', async () => {
    expect(await detectLauncher(project.root)).toBeUndefined();
    await writeFile(join(project.root, 'index.html'), page);
    expect(await detectLauncher(project.root)).toEqual({ type: 'static', dir: '.' });
  });
});

describe('AppServer', () => {
  const project = useTempProject();
  let app: AppServer | undefined;
  afterEach(async () => app?.stop());

  it('serves a static site, and nothing outside it', async () => {
    await writeFile(join(project.root, 'index.html'), page);
    app = new AppServer(project.root);
    const url = await app.url();
    expect(await (await fetch(url)).text()).toContain('Hello');
    expect((await fetch(`${url}/..%2f..%2fetc%2fpasswd`)).status).toBeGreaterThanOrEqual(403);
  });

  it('runs the dev script and finds the URL it prints', async () => {
    await writeFile(
      join(project.root, 'server.js'),
      `require('http').createServer((q, r) => r.end('dev app')).listen(process.env.PORT, () => console.log('ready on http://localhost:' + process.env.PORT));`,
    );
    await writeFile(
      join(project.root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.js' } }),
    );
    app = new AppServer(project.root);
    const url = await app.url();
    expect(await (await fetch(url)).text()).toBe('dev app');
    expect(await app.url()).toBe(url); // reused, not restarted
  });
});

describe.skipIf(!findBrowser())('Camera', () => {
  const project = useTempProject();
  const camera = new Camera();
  afterEach(async () => camera.close());

  it('captures a sharp viewport, a phone view, an element, and a capped full page', async () => {
    await writeFile(join(project.root, 'index.html'), page);
    const url = `file://${join(project.root, 'index.html')}`;
    const shot = (name: string) => join(project.root, 'shots', name);

    await camera.capture({ url, file: shot('desktop.png') });
    expect(await pngSize(shot('desktop.png'))).toEqual({ width: 2560, height: 1600 }); // 2x density

    await camera.capture({ url, file: shot('mobile.png'), device: 'mobile' });
    const mobile = await pngSize(shot('mobile.png'));
    expect(mobile.width).toBe(1170); // 3x density
    expect(Math.abs(mobile.height - 2532)).toBeLessThanOrEqual(2); // mobile emulation rounds a pixel

    await camera.capture({ url, file: shot('header.png'), selector: '#top' });
    expect((await pngSize(shot('header.png'))).height).toBe((60 + 16) * 2); // element + padding (clipped at the top)

    await camera.capture({ url, file: shot('full.png'), fullPage: true });
    expect((await pngSize(shot('full.png'))).height).toBe(800 * 3 * 2); // capped at three screens
  }, 60_000);
});
