import { stdin, stdout } from 'node:process';
import { createInterface, emitKeypressEvents, type Interface } from 'node:readline';
import { BRAND } from './banner.js';
import {
  type EditorState,
  initialState,
  type Key,
  type MenuItem,
  type MenuSource,
  reduce,
} from './editor.js';
import { paint } from './style.js';

const MAX_MENU_ITEMS = 8;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS_INTERVAL_MS = 100;

export interface ReadOptions {
  prompt: string;
  /** Suggestions shown under the input while typing, e.g. slash commands. */
  menu?: MenuSource;
  history?: readonly string[];
  /** Show typed characters as dots, for secrets. */
  mask?: boolean;
}

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
  disabled?: boolean;
}

/**
 * Line input with a live suggestion menu, and arrow-key pickers. In a real
 * terminal it runs in raw mode and redraws in place; with piped input it falls
 * back to plain lines so scripts and tests still work.
 */
export class Terminal {
  readonly interactive = Boolean(stdin.isTTY && stdout.isTTY);
  private onKey: ((key: Key) => void) | undefined;
  private onInterrupt: (() => void) | undefined;
  private lines: AsyncIterator<string> | undefined;
  private rl: Interface | undefined;
  private drawnCursorRow = 0;
  /** Redraws the input being read, so output and status updates can go around it. */
  private redrawInput: (() => void) | undefined;
  private readonly statuses = new Map<string, { text: string; since: number }>();
  private statusTimer: NodeJS.Timeout | undefined;
  private frame = 0;

  constructor() {
    if (this.interactive) {
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.on('keypress', this.handleKey);
    }
  }

  /** Called on Ctrl-C while nothing is being read, e.g. while Dazza is working. */
  interrupt(handler: (() => void) | undefined): void {
    this.onInterrupt = handler;
  }

  /**
   * Write output above the input line. Whatever the user is typing is redrawn
   * underneath, so Dazza can report work while they keep typing.
   */
  print(text: string): void {
    if (!this.interactive || !this.redrawInput) {
      stdout.write(`${text}\n`);
      return;
    }
    this.erase();
    stdout.write(`${text}\n`);
    this.redrawInput();
  }

  /** Show (or clear) an activity in the status line above the input, e.g. "Building T3". */
  setStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, { text, since: this.statuses.get(key)?.since ?? Date.now() });

    if (this.statuses.size > 0 && !this.statusTimer && this.interactive) {
      this.statusTimer = setInterval(() => {
        this.frame++;
        this.redrawInput?.();
      }, STATUS_INTERVAL_MS);
    } else if (this.statuses.size === 0 && this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.redrawInput?.();
  }

  /** The status line as it should look right now, or undefined when idle. */
  private statusLine(): string | undefined {
    if (this.statuses.size === 0) return undefined;
    const now = Date.now();
    const parts = [...this.statuses.values()].map(({ text, since }) => {
      const seconds = Math.floor((now - since) / 1000);
      const elapsed =
        seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      return `${text} ${paint.dim(`· ${elapsed}`)}`;
    });
    return `${paint.hex(BRAND, FRAMES[this.frame % FRAMES.length] ?? '')} ${parts.join(paint.dim('  ·  '))}`;
  }

  private erase(): void {
    stdout.write(`${this.drawnCursorRow > 0 ? `\x1b[${this.drawnCursorRow}A` : ''}\r\x1b[J`);
    this.drawnCursorRow = 0;
  }

  /** Read one line. Resolves undefined when the user cancels (Ctrl-C / Ctrl-D on empty). */
  async readLine(options: ReadOptions): Promise<string | undefined> {
    if (!this.interactive) return this.nextLine(options.prompt);

    let state = initialState(options.history);
    const menuFor: MenuSource = options.menu ?? (() => []);
    const redraw = (showMenu = true) =>
      this.draw(
        layout(
          options.prompt,
          state,
          showMenu ? menuFor(state.text) : [],
          options.mask,
          undefined,
          this.statusLine(),
        ),
      );
    this.redrawInput = redraw;
    redraw();

    return new Promise((resolve) => {
      const onResize = () => redraw();
      stdout.on('resize', onResize);
      this.onKey = (key) => {
        const outcome = reduce(state, key, menuFor);
        if (outcome.type === 'edit') {
          state = outcome.state;
          redraw();
          return;
        }
        // Leave the submitted line in the scrollback (showing what actually ran, e.g.
        // "/usage" when "/u" was picked), without the menu or status line.
        if (outcome.type === 'submit') state = { ...state, text: outcome.value };
        this.redrawInput = undefined;
        this.erase();
        this.draw(layout(options.prompt, state, [], options.mask));
        stdout.write('\n');
        this.drawnCursorRow = 0;
        this.onKey = undefined;
        stdout.off('resize', onResize);
        resolve(outcome.type === 'submit' ? outcome.value : undefined);
      };
    });
  }

  /** Pick one option with ↑/↓ and Enter. Resolves undefined if cancelled. */
  async select<T>(question: string, choices: Choice<T>[]): Promise<T | undefined> {
    const enabled = choices.filter((c) => !c.disabled);
    if (!this.interactive) {
      stdout.write(`${question}\n${choices.map((c, i) => `  ${i + 1}. ${c.label}`).join('\n')}\n`);
      const answer = (await this.nextLine('> '))?.trim();
      const picked = choices[Number(answer) - 1] ?? choices.find((c) => c.label === answer);
      return picked && !picked.disabled ? picked.value : undefined;
    }

    let index = Math.max(0, choices.indexOf(enabled[0] as Choice<T>));
    const labelWidth = Math.max(...choices.map((c) => c.label.length));
    const redraw = (final = false) => {
      const rows = choices.map((c, i) => {
        const active = i === index && !final;
        const marker = active ? paint.hex(BRAND, '›') : ' ';
        const padded = c.label.padEnd(labelWidth);
        const label = c.disabled ? paint.dim(padded) : active ? paint.bold(padded) : padded;
        return `  ${marker} ${label}${c.hint ? `   ${paint.dim(c.hint)}` : ''}`;
      });
      const picked = choices[index];
      const lines = final
        ? [`${paint.bold(question)} ${paint.dim(picked?.label ?? '')}`]
        : [paint.bold(question), ...rows];
      this.draw({ lines, cursorRow: lines.length - 1, cursorCol: 0 });
    };
    stdout.write('\x1b[?25l'); // hide the cursor while picking
    redraw();

    return new Promise((resolve) => {
      const step = (direction: 1 | -1) => {
        for (let i = 1; i <= choices.length; i++) {
          const next = (index + direction * i + choices.length) % choices.length;
          if (!choices[next]?.disabled) {
            index = next;
            return;
          }
        }
      };
      const finish = (value: T | undefined) => {
        redraw(true);
        stdout.write('\n\x1b[?25h');
        this.drawnCursorRow = 0;
        this.onKey = undefined;
        resolve(value);
      };
      this.onKey = (key) => {
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) step(-1);
        else if (key.name === 'down' || (key.ctrl && key.name === 'n')) step(1);
        else if (key.name === 'return') return finish(choices[index]?.value);
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
        redraw();
      };
    });
  }

  /** Give the terminal to a child process (e.g. an interactive sign-in), then take it back. */
  async handOver<T>(work: () => Promise<T>): Promise<T> {
    if (!this.interactive) return work();
    stdin.off('keypress', this.handleKey);
    stdin.setRawMode(false);
    try {
      return await work();
    } finally {
      stdin.setRawMode(true);
      stdin.on('keypress', this.handleKey);
      stdin.resume();
    }
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.interactive) {
      stdin.off('keypress', this.handleKey);
      stdin.setRawMode(false);
      stdin.pause();
    }
    this.rl?.close();
  }

  private handleKey = (_: string | undefined, key: Key | undefined) => {
    const pressed = key ?? {};
    if (this.onKey) this.onKey(pressed);
    else if (pressed.ctrl && pressed.name === 'c') this.onInterrupt?.();
  };

  private async nextLine(prompt: string): Promise<string | undefined> {
    if (!this.rl) {
      this.rl = createInterface({ input: stdin, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    stdout.write(prompt);
    const next = await this.lines?.next();
    stdout.write('\n');
    return next?.done ? undefined : next?.value;
  }

  /** Replace what was drawn last time with a new layout, leaving the cursor in place. */
  private draw({ lines, cursorRow, cursorCol }: Layout): void {
    let out = this.drawnCursorRow > 0 ? `\x1b[${this.drawnCursorRow}A` : '';
    out += `\r\x1b[J${lines.join('\n')}`;
    const up = lines.length - 1 - cursorRow;
    if (up > 0) out += `\x1b[${up}A`;
    out += `\r${cursorCol > 0 ? `\x1b[${cursorCol}C` : ''}`;
    stdout.write(out);
    this.drawnCursorRow = cursorRow;
  }
}

export interface Layout {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

/** Where every character and the cursor go, wrapping long input by hand. */
export function layout(
  prompt: string,
  state: EditorState,
  menu: MenuItem[],
  mask = false,
  columns = stdout.columns || 80,
  /** An activity line drawn above the input. */
  status?: string,
): Layout {
  // One column spare so the terminal never auto-wraps behind our back.
  const width = Math.max(10, columns - 1);
  const promptWidth = visibleLength(prompt);
  const text = mask ? '•'.repeat(state.text.length) : state.text;

  const lines: string[] = [];
  let first = true;
  let rest = text;
  do {
    const room = first ? width - promptWidth : width;
    lines.push((first ? prompt : '') + rest.slice(0, room));
    rest = rest.slice(room);
    first = false;
  } while (rest.length > 0);

  const position = promptWidth + state.cursor;
  let cursorRow = Math.floor(position / width);
  let cursorCol = position % width;
  if (cursorRow >= lines.length) {
    // The cursor sits just past a full final line: start a fresh one.
    lines.push('');
    cursorRow = lines.length - 1;
    cursorCol = 0;
  }

  if (menu.length > 0) lines.push(...menuLines(menu, state.menuIndex, width));
  return status === undefined
    ? { lines, cursorRow, cursorCol }
    : { lines: [status, ...lines], cursorRow: cursorRow + 1, cursorCol };
}

function menuLines(menu: MenuItem[], selectedIndex: number, width: number): string[] {
  const selected = Math.min(selectedIndex, menu.length - 1);
  // Keep the highlighted item in view when the list is longer than the window.
  const start = Math.max(0, Math.min(selected - MAX_MENU_ITEMS + 1, menu.length - MAX_MENU_ITEMS));
  const shown = menu.slice(start, start + MAX_MENU_ITEMS);
  const valueWidth = Math.max(...menu.map((m) => m.value.length)) + 2;

  return shown.map((item, i) => {
    const active = start + i === selected;
    const hint = truncate(item.hint, Math.max(0, width - valueWidth - 4));
    const value = item.value.padEnd(valueWidth);
    return active
      ? `  ${paint.hex(BRAND, paint.bold(value))}${hint}`
      : `  ${paint.dim(value)}${paint.dim(hint)}`;
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes.
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}
