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
}

/** The logo, with version, agent, working directory and board link underneath. */
export function banner({ version, agent, cwd, board }: BannerInfo): string {
  const logo = LOGO.map((row) => paint.hex(BRAND, row.trimEnd()));
  const info = `${paint.bold(`v${version}`)} ${paint.dim(`· ${agent} · ${cwd}`)}`;
  return [...logo, '', info, `${paint.dim('Board')} ${paint.hex(BRAND, board)}`].join('\n');
}
