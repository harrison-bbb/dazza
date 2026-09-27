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
}

/** The logo, with version, agent and working directory underneath. */
export function banner({ version, agent, cwd }: BannerInfo): string {
  const logo = LOGO.map((row) => paint.hex(BRAND, row.trimEnd()));
  const info = `${paint.bold(`v${version}`)} ${paint.dim(`· ${agent} · ${cwd}`)}`;
  return [...logo, '', info].join('\n');
}
