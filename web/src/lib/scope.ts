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

/** The "What I'll need from you" section, however the apostrophe was typed. */
export function needsFromYou(markdown: string): string | undefined {
  return scopeSections(markdown).find((s) => /^what i.ll need/i.test(s.title))?.body;
}
