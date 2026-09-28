/**
 * A link into the board: its address (which carries the board's key, `?t=…`)
 * with a page (`#/tasks/T3`) or a path (`/api/media/…`) put in the right place.
 */
export function boardLink(boardUrl: string, target: string): string {
  const url = new URL(boardUrl);
  if (target.startsWith('#')) url.hash = target.slice(1);
  else url.pathname = target;
  return url.toString();
}
