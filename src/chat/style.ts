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
  amber: wrap('33', '39'),
  /** What the user wrote: light text on a dark band, readable on light and dark terminals. */
  band: wrap('48;2;44;44;44;38;2;236;236;236', '49;39'),
  hex(color: string, text: string): string {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
    return wrap(`38;2;${r};${g};${b}`, '39')(text);
  },
};

/** Render the inline Markdown agents commonly emit: **bold** and `code`. */
export function renderInline(text: string): string {
  return (
    text
      // [text](url): the text, with a short form of where it goes.
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, label: string, url: string) => `${label} ${paint.dim(`(${shortUrl(url)})`)}`,
      )
      .replace(/\*\*(.+?)\*\*/g, (_, bold: string) => paint.bold(bold))
      .replace(/`([^`]+)`/g, (_, code: string) => paint.bold(code))
  );
}

/** "npmjs.com/package/zod": a link without its scheme, www, query or fragment. */
function shortUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname === '/' ? '' : pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

/** Plain text for places that can't show colour, e.g. Telegram. */
export function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching OSC 8 links.
      .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape codes.
      .replace(/\x1b\[[0-9;]*m/g, '')
  );
}

/**
 * Markdown as the terminal can show it, a line at a time so it works on a
 * reply as it streams in: headings in bold, bullets as •, quotes and code
 * blocks set off by a bar, rules as a line, and tables with their columns
 * lined up. A table is held back until its last row, since every row decides
 * the column widths.
 */
export class MarkdownLines {
  /** The fence that opened the code block we're in, e.g. "```". */
  private fence: string | undefined;
  private table: string[][] = [];

  /** Inside a code block: what's written there is code, not Markdown. */
  get inCode(): boolean {
    return this.fence !== undefined;
  }

  /** One line in, the lines to show for it out: none while a table is still arriving. */
  push(line: string): string[] {
    if (this.fence !== undefined) {
      if (line.trim().startsWith(this.fence)) {
        this.fence = undefined;
        return [];
      }
      return [codeLine(line)];
    }
    const row = tableCells(line);
    if (row) {
      this.table.push(row);
      return [];
    }
    const out = this.flush();
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      this.fence = fence[1];
      return [...out, ...(fence[2] ? [paint.dim(fence[2])] : [])];
    }
    return [...out, markdownLine(line)];
  }

  /** The reply has ended: whatever was held back (a table at the very end). */
  flush(): string[] {
    const rows = this.table;
    this.table = [];
    return rows.length > 0 ? renderTable(rows) : [];
  }
}

/** A whole piece of Markdown, rendered at once. */
export function renderMarkdown(text: string): string {
  const md = new MarkdownLines();
  return [...text.split('\n').flatMap((line) => md.push(line)), ...md.flush()].join('\n');
}

/** A line of a code block: kept as written, behind a bar. */
export function codeLine(line: string): string {
  return `${paint.dim('│')} ${line}`;
}

function markdownLine(line: string): string {
  const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return paint.bold(renderInline(heading[1] ?? ''));
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return paint.dim('─'.repeat(24));
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${renderInline(bullet[2] ?? '')}`;
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return `${paint.dim('│')} ${renderInline(quote[1] ?? '')}`;
  return renderInline(line);
}

/** A table row's cells, or undefined if the line isn't one. */
function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!/^\|.*\|$/.test(trimmed) || trimmed.length < 3) return undefined;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(rows: string[][]): string[] {
  const isRule = (row: string[]) => row.every((cell) => /^:?-+:?$/.test(cell));
  const header = rows.length > 1 && rows[1] && isRule(rows[1]) ? rows[0] : undefined;
  const body = rows.filter((row, i) => !isRule(row) && !(header && i === 0));
  const cells = (header ? [header, ...body] : body).map((row) => row.map(renderInline));
  const columns = Math.max(...cells.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.max(...cells.map((row) => visibleWidth(row[c] ?? ''))),
  );
  const line = (row: string[]) =>
    row
      .map((cell, c) => cell + ' '.repeat(Math.max(0, (widths[c] ?? 0) - visibleWidth(cell))))
      .join('  ')
      .trimEnd();
  const lines = cells.map(line);
  if (!header) return lines;
  return [
    paint.bold(lines[0] ?? ''),
    paint.dim(widths.map((w) => '─'.repeat(w)).join('  ')),
    ...lines.slice(1),
  ];
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}
