/**
 * A single-line input editor as a pure state machine: keys in, state out.
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
      default:
        return edit({});
    }
  }

  switch (key.name) {
    case 'return':
    case 'enter':
      // Enter on an open menu runs the highlighted command.
      if (selected?.value.startsWith(state.text)) {
        return { type: 'submit', value: selected.value };
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
      return browseHistory(state, -1);
    case 'down':
      if (menu.length > 0) return edit({ menuIndex: (state.menuIndex + 1) % menu.length });
      return browseHistory(state, 1);
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
