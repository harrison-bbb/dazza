import { spawn } from 'node:child_process';

/** Open a URL in the user's default browser, unless DAZZA_NO_BROWSER is set. Best effort. */
export function openInBrowser(url: string): void {
  // For headless use (a remote box, scripted runs): the URL is printed anyway.
  if (process.env.DAZZA_NO_BROWSER) return;
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url];
  if (!command) return;
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
