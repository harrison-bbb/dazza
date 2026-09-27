import { stdout } from 'node:process';
import { BRAND } from './banner.js';
import { paint } from './style.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/** A single-line activity indicator. Silent when stdout isn't a terminal. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text = '';

  start(text: string): void {
    this.text = text;
    if (!stdout.isTTY || this.timer) return;
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
    this.render();
  }

  update(text: string): void {
    this.text = text;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    stdout.write('\r\x1b[2K');
  }

  private render(): void {
    const frame = FRAMES[this.frame++ % FRAMES.length] ?? '';
    stdout.write(`\r\x1b[2K${paint.hex(BRAND, frame)} ${paint.dim(this.text)}`);
  }
}
