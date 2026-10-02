import { describe, expect, it } from 'vitest';
import { MarkdownLines, renderInline, renderMarkdown, stripAnsi } from '../../src/chat/style.js';

describe('renderInline', () => {
  // Tests run without a TTY, so styling is disabled and only the markers are stripped.
  it('strips bold and code markers', () => {
    expect(renderInline('**T1:** run `npm start` now')).toBe('T1: run npm start now');
  });

  it('leaves unmatched markers alone', () => {
    expect(renderInline('2 * 3 and a lone ` tick')).toBe('2 * 3 and a lone ` tick');
  });
});

describe('links', () => {
  it('shows a Markdown link as its text and a short address', () => {
    expect(
      stripAnsi(
        renderInline('See [zod – npm](https://www.npmjs.com/package/zod?activeTab=versions).'),
      ),
    ).toBe('See zod – npm (npmjs.com/package/zod).');
  });
});

describe('renderMarkdown', () => {
  it('shows headings, bullets, quotes and rules as the terminal can', () => {
    expect(
      renderMarkdown(
        [
          '## Booking',
          '- Clients pick a **slot**',
          '  * nested',
          '> a quote',
          '---',
          '1. kept',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Booking',
        '• Clients pick a slot',
        '  • nested',
        '│ a quote',
        '─'.repeat(24),
        '1. kept',
      ].join('\n'),
    );
  });

  it('keeps code blocks as written, fences and all their markers gone', () => {
    expect(renderMarkdown('Run:\n```ts\nconst a = `x` * 2;\n# not a heading\n```\nDone')).toBe(
      ['Run:', 'ts', '│ const a = `x` * 2;', '│ # not a heading', 'Done'].join('\n'),
    );
  });

  it('lines up a table’s columns, with its header', () => {
    expect(
      renderMarkdown('| Plan | Price |\n|---|---:|\n| Solo walker | $10 |\n| Team | $25 |'),
    ).toBe(
      ['Plan         Price', '───────────  ─────', 'Solo walker  $10', 'Team         $25'].join(
        '\n',
      ),
    );
  });

  it('holds a table back until its last row, as a reply streams in', () => {
    const md = new MarkdownLines();
    expect(md.push('| a | b |')).toEqual([]);
    expect(md.push('| long cell | c |')).toEqual([]);
    expect(md.push('after')).toEqual(['a          b', 'long cell  c', 'after']);
    expect(md.push('| x |')).toEqual([]);
    expect(md.flush()).toEqual(['x']);
  });

  it('knows when it’s inside a code block', () => {
    const md = new MarkdownLines();
    md.push('```');
    expect(md.inCode).toBe(true);
    md.push('```');
    expect(md.inCode).toBe(false);
  });
});
