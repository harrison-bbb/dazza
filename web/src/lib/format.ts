const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });

export function timeAgo(iso: string, now = Date.now()): string {
  // Clamp to the past: a timestamp slightly ahead (clock skew) still reads "just now".
  const diff = Math.min(0, new Date(iso).getTime() - now);
  for (const [unit, ms] of UNITS) {
    // Round first, so 59.6 minutes reads "1 hr ago" rather than "60 min ago".
    const value = Math.round(diff / ms);
    if (value <= -1) return rtf.format(value, unit);
  }
  return 'just now';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function titleCase(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
