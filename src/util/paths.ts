import { relative, sep } from 'node:path';

/**
 * A path relative to `from`, written with forward slashes on every system, as
 * the user and the model expect to read it (`src/app.ts`, not `src\app.ts`).
 */
export function shownPath(from: string, to: string): string {
  const path = relative(from, to);
  return sep === '\\' ? path.replaceAll('\\', '/') : path;
}
