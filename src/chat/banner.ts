import { paint } from './style.js';

/*
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  YOUR LOGO GOES HERE                                                 │
 * │                                                                      │
 * │  Each string is one row of the logo, printed left of the info lines. │
 * │  Keep it 3–5 rows tall so it lines up. Block characters work well:   │
 * │    █ ▀ ▄ ▌ ▐ ▖ ▗ ▘ ▝ ▚ ▞ ▛ ▜ ▙ ▟ ░ ▒ ▓                                │
 * │  Rows can be different widths; they're padded automatically.         │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const LOGO = [
  ' █▀▀▄ ', //
  ' █  █ ',
  ' ▀▀▀  ',
];

/** Brand colour for the logo and accents, as a hex string. */
export const BRAND = '#F5A623';

export interface BannerInfo {
  version: string;
  agent: string;
  cwd: string;
}

export function banner({ version, agent, cwd }: BannerInfo): string {
  const info = [
    `${paint.bold('Dazza')} ${paint.dim(`v${version}`)}`,
    paint.dim(agent),
    paint.dim(cwd),
  ];
  const width = Math.max(...LOGO.map((row) => row.length));
  const rows = Math.max(LOGO.length, info.length);

  return Array.from({ length: rows }, (_, i) => {
    const logo = (LOGO[i] ?? '').padEnd(width);
    return `${paint.hex(BRAND, logo)}  ${info[i] ?? ''}`.trimEnd();
  }).join('\n');
}
