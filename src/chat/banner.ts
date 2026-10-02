import { paint } from './style.js';

const LOGO = [
  '██████╗  █████╗ ███████╗███████╗ █████╗ ',
  '██╔══██╗██╔══██╗╚══███╔╝╚══███╔╝██╔══██╗',
  '██║  ██║███████║  ███╔╝   ███╔╝ ███████║',
  '██║  ██║██╔══██║ ███╔╝   ███╔╝  ██╔══██║',
  '██████╔╝██║  ██║███████╗███████╗██║  ██║',
  '╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝',
];

/** Brand colour for the logo and accents. */
export const BRAND = '#53C66A';

export interface BannerInfo {
  version: string;
  agent: string;
  cwd: string;
  board: string;
  /** After the first launch: the name on the same line, instead of the big logo above. */
  compact?: boolean;
  /** Whether the terminal makes links clickable without showing them (OSC 8). */
  hyperlinks?: boolean;
}

/** The DAZZA wordmark, shown first thing on launch. */
export function logo(): string {
  return LOGO.map((row) => paint.hex(BRAND, row.trimEnd())).join('\n');
}

/** Version, agent, working directory and board link, shown under the logo once connected. */
export function sessionInfo({
  version,
  agent,
  cwd,
  board,
  compact,
  hyperlinks,
}: BannerInfo): string {
  const name = compact ? `${paint.hex(BRAND, paint.bold('Dazza'))} ` : '';
  const info = `${name}${paint.bold(`v${version}`)} ${paint.dim(`· ${agent} · ${cwd}`)}`;
  // The board's address carries its key: where the terminal can, show the address and link the rest.
  const shown = hyperlinks ? link(board, new URL(board).host) : board;
  return [
    info,
    `${paint.dim('Board')} ${paint.hex(BRAND, shown)}${paint.dim(' · /dashboard opens it')}`,
  ].join('\n');
}

/** A clickable link showing `text` (OSC 8), for terminals that support it. */
export function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Terminals known to show OSC 8 links as clickable text. Elsewhere the address is shown whole. */
export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!process.stdout.isTTY) return false;
  const program = env.TERM_PROGRAM ?? '';
  return (
    ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'WarpTerminal'].includes(program) ||
    env.TERM === 'xterm-kitty' ||
    Boolean(env.WT_SESSION)
  );
}

/** "~/code/app", or "~/…/clients/app" when that's still too long. */
export function shortPath(path: string, home: string, max = 48): string {
  const shown = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  if (shown.length <= max) return shown;
  const parts = shown.split('/');
  const tail = parts.slice(-2).join('/');
  return `${parts[0] || ''}/…/${tail}`;
}
