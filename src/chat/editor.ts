/**
 * The input editor as a pure state machine: keys in, state out. One line, or
 * several (backslash then Enter, Option+Enter or Ctrl+J start a new line).
 * The terminal layer (terminal.ts) feeds it keypresses and draws the result,
 * which keeps all the editing behaviour unit-testable.
 */

export interface Key {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

export interface MenuItem {
  /** What gets submitted or completed, e.g. "/model". */
  value: string;
  hint: string;
  /** Shown instead of the value, e.g. "@src/app.ts" when the value is the whole message. */
  label?: string;
  /** Enter completes it into the message instead of sending, like @ mentions. */
  insert?: boolean;
}

export interface EditorState {
  text: string;
  cursor: number;
  history: readonly string[];
  /** Position while browsing history; equal to history.length when not browsing. */
  historyIndex: number;
  /** Text typed before browsing history, restored when coming back down. */
  draft: string;
  menuIndex: number;
  /** Long pastes, shown as placeholders like "[Pasted text #1 · 42 lines]" until submitted. */
  pastes: readonly string[];
  /**
   * Ctrl+R: searching earlier messages. `index` is the match shown (history's
   * length when there's none), `draft` what was typed before searching.
   */
  search?: { query: string; index: number; draft: string } | undefined;
}

export type Outcome =
  | { type: 'edit'; state: EditorState }
  | { type: 'submit'; value: string }
  | { type: 'cancel' };

export function initialState(history: readonly string[] = []): EditorState {
  return {
    text: '',
    cursor: 0,
    history,
    historyIndex: history.length,
    draft: '',
    menuIndex: 0,
    pastes: [],
  };
}

/** Menu entries for the current text, or none when the menu is closed. */
export type MenuSource = (text: string) => MenuItem[];

export function reduce(state: EditorState, key: Key, menuFor: MenuSource): Outcome {
  if (state.search) return searching(state, state.search, key);
  const menu = menuFor(state.text);
  const selected = menu[Math.min(state.menuIndex, menu.length - 1)];
  const edit = (next: Partial<EditorState>): Outcome => ({
    type: 'edit',
    state: { ...state, ...next },
  });
  const setText = (text: string, cursor = text.length): Outcome =>
    edit({ text, cursor, menuIndex: 0, historyIndex: state.history.length });

  if (key.ctrl) {
    switch (key.name) {
      case 'c':
        return state.text ? setText('') : { type: 'cancel' };
      case 'd':
        return state.text ? edit({}) : { type: 'cancel' };
      case 'a':
        return edit({ cursor: 0 });
      case 'e':
        return edit({ cursor: state.text.length });
      case 'u':
        return setText(state.text.slice(state.cursor), 0);
      case 'k':
        return setText(state.text.slice(0, state.cursor), state.cursor);
      case 'w': {
        const before = state.text.slice(0, state.cursor).replace(/\S+\s*$/, '');
        return setText(before + state.text.slice(state.cursor), before.length);
      }
      case 'left':
        return edit({ cursor: wordLeft(state.text, state.cursor) });
      case 'right':
        return edit({ cursor: wordRight(state.text, state.cursor) });
      case 'r':
        return edit({
          search: { query: '', index: state.history.length, draft: state.text },
        });
      default:
        return edit({});
    }
  }

  // Option (Alt) with an arrow, or b and f as in a shell: a word at a time.
  if (key.meta && (key.name === 'left' || key.name === 'b')) {
    return edit({ cursor: wordLeft(state.text, state.cursor) });
  }
  if (key.meta && (key.name === 'right' || key.name === 'f')) {
    return edit({ cursor: wordRight(state.text, state.cursor) });
  }
  if (key.meta && key.name === 'backspace') {
    const at = wordLeft(state.text, state.cursor);
    return setText(state.text.slice(0, at) + state.text.slice(state.cursor), at);
  }

  const newline = () =>
    setText(
      `${state.text.slice(0, state.cursor)}\n${state.text.slice(state.cursor)}`,
      state.cursor + 1,
    );
  switch (key.name) {
    // Ctrl+J (and Shift+Enter, where the terminal sends it that way): a new line.
    case 'enter':
      return newline();
    case 'return':
      // Option+Enter: a new line.
      if (key.meta) return newline();
      // Enter on a mention completes it, ready to keep typing.
      if (selected?.insert) return setText(`${selected.value} `);
      // Enter on an open menu runs the highlighted command.
      if (selected?.value.startsWith(state.text)) {
        return { type: 'submit', value: selected.value };
      }
      // A backslash just before the cursor: a new line in its place, as in Claude Code.
      if (state.text[state.cursor - 1] === '\\') {
        return setText(
          `${state.text.slice(0, state.cursor - 1)}\n${state.text.slice(state.cursor)}`,
          state.cursor,
        );
      }
      return { type: 'submit', value: expandPastes(state.text, state.pastes) };
    case 'paste': {
      // A whole paste at once (the terminal collects it), so its newlines don't submit.
      const pasted = (key.sequence ?? '').replace(/\r\n?/g, '\n');
      const long = pasted.includes('\n') || pasted.length > MAX_INLINE_PASTE;
      const insert = long ? placeholder(state.pastes.length + 1, pasted) : pasted;
      return {
        type: 'edit',
        state: {
          ...state,
          text: state.text.slice(0, state.cursor) + insert + state.text.slice(state.cursor),
          cursor: state.cursor + insert.length,
          menuIndex: 0,
          historyIndex: state.history.length,
          pastes: long ? [...state.pastes, pasted] : state.pastes,
        },
      };
    }
    case 'tab':
      return selected ? setText(`${selected.value} `) : edit({});
    case 'escape':
      return menu.length > 0 ? setText('') : edit({});
    case 'up':
      if (menu.length > 0)
        return edit({ menuIndex: (state.menuIndex - 1 + menu.length) % menu.length });
      // Several lines: move up a line first; from the top line, go back through history.
      return moveLine(state, -1) ?? browseHistory(state, -1);
    case 'down':
      if (menu.length > 0) return edit({ menuIndex: (state.menuIndex + 1) % menu.length });
      return moveLine(state, 1) ?? browseHistory(state, 1);
    case 'left':
      return edit({ cursor: Math.max(0, state.cursor - 1) });
    case 'right':
      return edit({ cursor: Math.min(state.text.length, state.cursor + 1) });
    case 'home':
      return edit({ cursor: 0 });
    case 'end':
      return edit({ cursor: state.text.length });
    case 'backspace':
      {
        if (state.cursor === 0) return edit({});
        // A paste's placeholder goes in one keypress, not character by character.
        const token = PLACEHOLDER_AT_END.exec(state.text.slice(0, state.cursor))?.[0];
        if (token) {
          const at = state.cursor - token.length;
          return setText(state.text.slice(0, at) + state.text.slice(state.cursor), at);
        }
      }
      return setText(
        state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
        state.cursor - 1,
      );
    case 'delete':
      return setText(
        state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1),
        state.cursor,
      );
  }

  const typed = printable(key);
  if (!typed) return edit({});
  return setText(
    state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor),
    state.cursor + typed.length,
  );
}

/** Where the word before the cursor starts. */
function wordLeft(text: string, cursor: number): number {
  return text.slice(0, cursor).replace(/\w+\W*$|\W+$/, '').length;
}

/** Where the word after the cursor ends. */
function wordRight(text: string, cursor: number): number {
  const rest = /^\W*\w+|^\W+/.exec(text.slice(cursor));
  return cursor + (rest?.[0].length ?? 0);
}

/**
 * Ctrl+R: type to find the latest earlier message containing it; Ctrl+R
 * again for the one before. Enter, Tab or an arrow keeps it to edit or send;
 * Esc or Ctrl+C goes back to what was typed.
 */
function searching(
  state: EditorState,
  search: NonNullable<EditorState['search']>,
  key: Key,
): Outcome {
  const find = (query: string, before: number) => {
    const q = query.toLowerCase();
    for (let i = Math.min(before, state.history.length) - 1; i >= 0; i--) {
      if (q && state.history[i]?.toLowerCase().includes(q)) return i;
    }
    return state.history.length;
  };
  const show = (query: string, index: number): Outcome => {
    const text = index < state.history.length ? (state.history[index] ?? '') : search.draft;
    return {
      type: 'edit',
      state: { ...state, text, cursor: text.length, search: { ...search, query, index } },
    };
  };
  if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
    return {
      type: 'edit',
      state: { ...state, text: search.draft, cursor: search.draft.length, search: undefined },
    };
  }
  if (key.ctrl && key.name === 'r') return show(search.query, find(search.query, search.index));
  if (key.name === 'backspace') {
    const query = search.query.slice(0, -1);
    return show(query, find(query, state.history.length));
  }
  const typed = key.ctrl || key.name === 'return' || key.name === 'tab' ? '' : printable(key);
  if (typed) {
    const query = search.query + typed;
    return show(query, find(query, state.history.length));
  }
  // Anything else keeps what was found, ready to edit or send.
  return {
    type: 'edit',
    state: { ...state, search: undefined, historyIndex: state.history.length, menuIndex: 0 },
  };
}

/** The cursor a line up or down, at the same column where it can be; undefined at the edge. */
function moveLine(state: EditorState, step: -1 | 1): Outcome | undefined {
  const lines = state.text.split('\n');
  let start = 0;
  let row = 0;
  while (row < lines.length - 1 && start + (lines[row]?.length ?? 0) < state.cursor) {
    start += (lines[row]?.length ?? 0) + 1;
    row++;
  }
  const target = row + step;
  if (target < 0 || target >= lines.length) return undefined;
  const column = state.cursor - start;
  const targetStart =
    step < 0 ? start - (lines[target]?.length ?? 0) - 1 : start + (lines[row]?.length ?? 0) + 1;
  return {
    type: 'edit',
    state: { ...state, cursor: targetStart + Math.min(column, lines[target]?.length ?? 0) },
  };
}

function browseHistory(state: EditorState, step: -1 | 1): Outcome {
  const index = Math.min(state.history.length, Math.max(0, state.historyIndex + step));
  if (index === state.historyIndex) return { type: 'edit', state };
  const draft = state.historyIndex === state.history.length ? state.text : state.draft;
  const text = index === state.history.length ? draft : (state.history[index] ?? '');
  return {
    type: 'edit',
    state: { ...state, text, cursor: text.length, historyIndex: index, draft },
  };
}

/** Pastes longer than this, or with line breaks, show as a placeholder. */
const MAX_INLINE_PASTE = 200;
const PLACEHOLDER = /\[Pasted text #(\d+) · [^\]]+\]/g;
const PLACEHOLDER_AT_END = /\[Pasted text #\d+ · [^\]]+\]$/;

function placeholder(n: number, text: string): string {
  const lines = text.split('\n').length;
  return `[Pasted text #${n} · ${lines > 1 ? `${lines} lines` : `${text.length} characters`}]`;
}

/** The text as typed, with each paste's placeholder swapped back for what was pasted. */
export function expandPastes(text: string, pastes: readonly string[]): string {
  return text.replace(PLACEHOLDER, (token, n: string) => pastes[Number(n) - 1] ?? token);
}

/** Text a key inserts: printable characters only (pastes arrive whole, as 'paste'). */
function printable(key: Key): string {
  if (key.meta || !key.sequence) return '';
  // Terminals without bracketed paste send pasted lines as keys; keep them on one line.
  const text = key.sequence.replace(/\r?\n/g, ' ');
  // Drop control characters and unhandled escape sequences.
  const isControl = (c: string) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127;
  return [...text].some(isControl) ? '' : text;
}
