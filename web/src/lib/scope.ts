import { slugify } from './format';

export interface ScopeSection {
  title: string;
  slug: string;
  body: string;
}

/** Split the scope document into its `## ` sections. */
export function scopeSections(markdown: string): ScopeSection[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [title = '', ...rest] = chunk.split('\n');
      return { title: title.trim(), slug: slugify(title), body: rest.join('\n').trim() };
    });
}

/** The first sentence of the Overview, as a one-line summary of the project. */
export function scopeSummary(markdown: string): string | undefined {
  const overview = scopeSections(markdown).find((s) => /^overview/i.test(s.title))?.body;
  return (
    overview
      ?.replace(/\s+/g, ' ')
      .match(/^.*?[.!?](\s|$)/)?.[0]
      .trim() ?? overview
  );
}
