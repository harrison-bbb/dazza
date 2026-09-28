import { basename } from 'node:path';
import { execCommand } from '../util/process.js';
import type { Channel, Remote } from './channel.js';
import type { Notification } from './notification.js';

/**
 * A notification on the user's own computer, for when they're in another
 * window: a task ready for review, a question, a milestone. macOS and Linux;
 * elsewhere it stays quiet. It only tells; answers happen in Dazza.
 */
export class DesktopNotifier implements Channel {
  readonly id = 'desktop';

  constructor(
    private readonly project: string,
    private readonly show: (title: string, body: string) => Promise<void> = showNotification,
  ) {}

  start(): void {}

  async stop(): Promise<void> {}

  refresh(): void {}

  async reply(_text: string, _to: Remote): Promise<void> {}

  async notify(note: Notification): Promise<void> {
    await this.show(`Dazza · ${basename(this.project)}`, desktopText(note)).catch(() => {});
  }
}

/** One or two short lines: notifications get truncated. */
export function desktopText(note: Notification): string {
  switch (note.kind) {
    case 'review':
      return `${note.taskId} is ready for your review: ${note.title}`;
    case 'blocked':
      return `${note.taskId} needs you: ${note.question ?? note.title}`;
    case 'permission':
      return `${note.taskId} wants to run a command that needs your OK`;
    case 'milestone':
      return `${note.id} reached: ${note.title}`;
    case 'info':
      return note.text;
  }
}

async function showNotification(title: string, body: string): Promise<void> {
  if (process.platform === 'darwin') {
    const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await execCommand('osascript', [
      '-e',
      `display notification ${quote(body.slice(0, 200))} with title ${quote(title)}`,
    ]);
  } else if (process.platform === 'linux') {
    await execCommand('notify-send', ['--app-name=Dazza', title, body.slice(0, 200)]);
  }
}
