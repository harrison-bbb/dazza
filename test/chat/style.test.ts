import { describe, expect, it } from 'vitest';
import { renderInline, stripAnsi } from '../../src/chat/style.js';

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
