import { describe, expect, it } from 'vitest';
import {
  type EditorState,
  initialState,
  type Key,
  type MenuSource,
  reduce,
} from '../../src/chat/editor.js';
import { stripAnsi } from '../../src/chat/style.js';
import { clipVisible, layout, userMessage, wrap } from '../../src/chat/terminal.js';

const commands = ['/dashboard', '/help', '/model', '/usage'];
const menu: MenuSource = (text) =>
  text.startsWith('/') && !text.includes(' ')
    ? commands.filter((c) => c.startsWith(text)).map((value) => ({ value, hint: `${value} hint` }))
    : [];

/** Feed keys (strings are typed character by character) and return the final outcome. */
function press(keys: (string | Key)[], start: EditorState = initialState()) {
  let state = start;
  for (const key of keys) {
    const presses: Key[] = typeof key === 'string' ? [...key].map((c) => ({ sequence: c })) : [key];
    for (const k of presses) {
      const outcome = reduce(state, k, menu);
      if (outcome.type !== 'edit') return outcome;
      state = outcome.state;
    }
  }
  return { type: 'edit' as const, state };
}

const key = (name: string, extra: Partial<Key> = {}): Key => ({ name, ...extra });

describe('editor', () => {
  it('types, moves and deletes', () => {
    const result = press(['helo', key('left'), 'l', key('end'), '!', key('backspace')]);
    expect(result).toMatchObject({ state: { text: 'hello', cursor: 5 } });
  });

  it('submits the typed text', () => {
    expect(press(['hi there', key('return')])).toEqual({ type: 'submit', value: 'hi there' });
  });

  it('opens the menu on "/" and runs the highlighted command on Enter', () => {
    expect(press(['/', key('down'), key('down'), key('return')])).toEqual({
      type: 'submit',
      value: '/model',
    });
  });

  it('filters as you type and wraps the selection', () => {
    expect(press(['/u', key('return')])).toEqual({ type: 'submit', value: '/usage' });
    expect(press(['/', key('up'), key('return')])).toEqual({ type: 'submit', value: '/usage' });
  });

  it('completes with Tab so arguments can follow', () => {
    expect(press(['/mo', key('tab'), '3', key('return')])).toEqual({
      type: 'submit',
      value: '/model 3',
    });
  });

  it('submits unknown commands as typed', () => {
    expect(press(['/nope', key('return')])).toEqual({ type: 'submit', value: '/nope' });
  });

  it('browses history and restores the draft', () => {
    const start = initialState(['first', 'second']);
    expect(press(['dr', key('up')], start)).toMatchObject({ state: { text: 'second' } });
    expect(press(['dr', key('up'), key('up'), key('down'), key('down')], start)).toMatchObject({
      state: { text: 'dr' },
    });
  });

  it('clears on Ctrl-C, then cancels on an empty line', () => {
    expect(press(['abc', key('c', { ctrl: true })])).toMatchObject({ state: { text: '' } });
    expect(press([key('c', { ctrl: true })])).toEqual({ type: 'cancel' });
  });

  it('deletes words and lines', () => {
    expect(press(['one two', key('w', { ctrl: true })])).toMatchObject({ state: { text: 'one ' } });
    expect(press(['one two', key('u', { ctrl: true })])).toMatchObject({ state: { text: '' } });
  });

  it('ignores control characters and flattens pasted newlines', () => {
    expect(press([{ sequence: '\x1b[Z' }, { sequence: 'a\nb' }])).toMatchObject({
      state: { text: 'a b' },
    });
  });
});

describe('layout', () => {
  const state = (text: string, cursor = text.length) => ({ ...initialState(), text, cursor });

  it('puts the cursor after the prompt', () => {
    expect(layout('› ', state('hi'), [], false, 40)).toEqual({
      lines: ['› hi'],
      cursorRow: 0,
      cursorCol: 4,
    });
  });

  it('wraps long input by hand and tracks the cursor row', () => {
    const { lines, cursorRow, cursorCol } = layout('› ', state('x'.repeat(30)), [], false, 21);
    expect(lines).toEqual([`› ${'x'.repeat(18)}`, 'x'.repeat(12)]);
    expect([cursorRow, cursorCol]).toEqual([1, 12]);
  });

  it('adds menu lines under the input, cursor staying on the input', () => {
    const result = layout('› ', state('/'), menu('/'), false, 60);
    expect(result.lines).toHaveLength(1 + commands.length);
    expect(result.lines[1]).toContain('/dashboard');
    expect(result.cursorRow).toBe(0);
  });

  it('masks secrets', () => {
    expect(layout('Key: ', state('sk-123'), [], true, 40).lines[0]).toBe('Key: ••••••');
  });

  it('takes a pasted line as typed text', () => {
    expect(press(['say ', key('paste', { sequence: 'hello' }), key('return')])).toEqual({
      type: 'submit',
      value: 'say hello',
    });
  });

  it('shows a multi-line paste as a placeholder, and submits all of it', () => {
    const log = 'Error: boom\n  at a.js:1\n  at b.js:2';
    const typed = press(['look: ', key('paste', { sequence: log })]);
    expect(typed).toMatchObject({ state: { text: 'look: [Pasted text #1 · 3 lines]' } });
    expect(press([key('return')], (typed as { state: EditorState }).state)).toEqual({
      type: 'submit',
      value: `look: ${log}`,
    });
  });

  it('deletes a paste’s placeholder in one backspace', () => {
    const result = press(['a ', key('paste', { sequence: 'x\ny' }), key('backspace')]);
    expect(result).toMatchObject({ state: { text: 'a ', cursor: 2 } });
  });
});

describe('several lines', () => {
  it('starts a new line with backslash then Enter, Option+Enter or Ctrl+J, and sends on Enter', () => {
    expect(press(['one\\', key('return'), 'two', key('return')])).toEqual({
      type: 'submit',
      value: 'one\ntwo',
    });
    expect(press(['a', { name: 'return', meta: true }, 'b', key('return')])).toEqual({
      type: 'submit',
      value: 'a\nb',
    });
    expect(press(['a', key('enter'), 'b', key('return')])).toEqual({
      type: 'submit',
      value: 'a\nb',
    });
  });

  it('moves up and down between lines before going through history', () => {
    const start = initialState(['earlier message']);
    // Type two lines, go up a line, and type at the same column.
    expect(press(['abc', key('enter'), 'de', key('up'), 'X', key('return')], start)).toEqual({
      type: 'submit',
      value: 'abX\nde'.replace('abX', 'abXc'),
    });
    // From the top line, up recalls history as before.
    expect(press(['x', key('up'), key('return')], start)).toEqual({
      type: 'submit',
      value: 'earlier message',
    });
  });

  it('lays out each line under the text, with the cursor where it belongs', () => {
    const state = { ...initialState(), text: 'hello\nworld', cursor: 8 };
    const { lines, cursorRow, cursorCol } = layout('› ', state, [], false, 40);
    expect(lines).toEqual(['› hello', '  world']);
    expect([cursorRow, cursorCol]).toEqual([1, 4]);
  });
});

describe('wrap', () => {
  it('breaks long lines between words, keeping the indent, and ignores colour codes', () => {
    const text = '  The quick brown fox jumps over the lazy dog near the riverbank today';
    expect(wrap(text, 30)).toBe(
      '  The quick brown fox jumps\n  over the lazy dog near the\n  riverbank today',
    );
    expect(wrap('\x1b[2mshort line\x1b[22m', 30)).toBe('\x1b[2mshort line\x1b[22m');
    expect(wrap('a\n\nb', 30)).toBe('a\n\nb');
  });

  it('continues under the text of a marked or bulleted line', () => {
    expect(wrap('● The quick brown fox jumps over the lazy dog', 30)).toBe(
      '● The quick brown fox jumps\n  over the lazy dog',
    );
    expect(wrap('  - The quick brown fox jumps over the lazy dog', 30)).toBe(
      '  - The quick brown fox jumps\n    over the lazy dog',
    );
  });
});

describe('userMessage', () => {
  it('marks what the user sent, wrapping under the text and keeping their line breaks', () => {
    // Tests run without colour, so this is the plain form: no band, no padding.
    expect(userMessage('the quick brown fox jumps over the lazy dog', 24)).toBe(
      '› the quick brown fox\n  jumps over the lazy\n  dog',
    );
    expect(userMessage('first\nsecond', 40)).toBe('› first\n  second');
  });
});

describe('clipVisible', () => {
  it('cuts to the visible width, keeping colour codes and resetting at the cut', () => {
    const coloured = `\x1b[2mBuilding T3\x1b[22m · ~12 min left`;
    expect(clipVisible(coloured, 100)).toBe(coloured);
    const cut = clipVisible(coloured, 10);
    expect(cut).toBe('\x1b[2mBuilding …\x1b[0m');
    expect(stripAnsi(cut)).toHaveLength(10);
  });
});
