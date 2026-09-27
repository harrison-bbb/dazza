import { stdout } from 'node:process';

/** Terminal styling that switches itself off for pipes and NO_COLOR. */
const enabled = stdout.isTTY && stdout.hasColors();

const wrap = (open: string, close: string) => (text: string) =>
  enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const paint = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  cyan: wrap('36', '39'),
  hex(color: string, text: string): string {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
    return wrap(`38;2;${r};${g};${b}`, '39')(text);
  },
};

/** Render the inline Markdown agents commonly emit: **bold** and `code`. */
export function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_, bold: string) => paint.bold(bold))
    .replace(/`([^`]+)`/g, (_, code: string) => paint.cyan(code));
}
