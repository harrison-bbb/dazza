import { execCommand } from '../util/process.js';

/**
 * Getting git onto the machine: every task is built on its own git branch, so
 * Dazza can plan without it but can't build. Where there's one command that
 * does it without an admin password prompt Dazza can't see, it offers to run it.
 */

export interface GitInstall {
  /** What to tell the user. */
  how: string;
  /** A command Dazza can run for them, with their OK. */
  run?: { command: string; args: string[]; label: string };
}

export function gitInstall(platform: NodeJS.Platform = process.platform): GitInstall {
  if (platform === 'darwin') {
    return {
      how: 'Install Apple’s command line developer tools, which include git: run xcode-select --install.',
      run: {
        command: 'xcode-select',
        args: ['--install'],
        label: 'opens Apple’s installer; follow it, then start Dazza again',
      },
    };
  }
  if (platform === 'win32') {
    return {
      how: 'Install Git for Windows from https://git-scm.com/download/win, or run winget install --id Git.Git -e.',
      run: {
        command: 'winget',
        args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget'],
        label: 'installs Git for Windows; open a new terminal after',
      },
    };
  }
  return {
    how: 'Install it with your package manager: sudo apt install git (Debian, Ubuntu), sudo dnf install git (Fedora), or see https://git-scm.com/download/linux.',
  };
}

export async function hasGit(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  // On a Mac without Apple's developer tools, /usr/bin/git is a stand-in that
  // opens Apple's installer when run. Check for the tools first, so merely
  // looking doesn't pop up a dialog (and so Dazza's own offer isn't a second one).
  if (platform === 'darwin' && (await onPath('git')) === '/usr/bin/git') {
    if ((await execCommand('xcode-select', ['-p']))?.exitCode !== 0) return false;
  }
  return (await execCommand('git', ['--version']))?.exitCode === 0;
}

/** Where a command is found on PATH, if it is. */
async function onPath(command: string): Promise<string | undefined> {
  const found = await execCommand('/bin/sh', ['-c', `command -v ${command}`]);
  return found?.exitCode === 0 ? found.stdout.trim() || undefined : undefined;
}
