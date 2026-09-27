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

/** The DAZZA wordmark, shown first thing on launch. */
export function logo(): string {
  return LOGO.map((row) => paint.hex(BRAND, row.trimEnd())).join('\n');
}

/** Version, agent, working directory and board link, shown under the logo once connected. */
export function sessionInfo({ version, agent, cwd, board }: BannerInfo): string {
  const info = `${paint.bold(`v${version}`)} ${paint.dim(`· ${agent} · ${cwd}`)}`;
  return [info, `${paint.dim('Board')} ${paint.hex(BRAND, board)}`].join('\n');
}
