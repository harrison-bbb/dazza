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

/** What the status line says: fixed, or worked out afresh at each redraw. */
export type StatusText = string | (() => string);

const MAX_MENU_ITEMS = 8;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS_INTERVAL_MS = 100;
/** A streaming reply's unfinished paragraph shows at most this many lines. */
const MAX_DRAFT_LINES = 12;
const MAX_TYPED_AHEAD = 500;
/** Ask the terminal to mark pastes, so a pasted newline isn't Enter. */
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';

export interface ReadOptions {
  prompt: string;
  /** Suggestions shown under the input while typing, e.g. slash commands. */
  menu?: MenuSource;
  history?: readonly string[];
  /** Show typed characters as dots, for secrets. */
  mask?: boolean;
  /** Esc on an empty line: stop what's replying, as in Claude Code. */
  onInterrupt?: () => void;
  /** Ctrl+V: an image on the clipboard, as text to insert (its saved path), if there is one. */
  pasteImage?: () => Promise<string | undefined>;
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
  private lines: AsyncIterator<string> | undefined;
  private rl: Interface | undefined;
  private drawnCursorRow = 0;
  /** Redraws the input being read, so output and status updates can go around it. */
  private redrawInput: (() => void) | undefined;
  private readonly statuses = new Map<string, { text: StatusText; since: number }>();
  private statusTimer: NodeJS.Timeout | undefined;
  private frame = 0;
  /** A streaming reply's unfinished line, shown above the status line. */
  private draft: string | undefined;
  /** While a `!` command runs, Ctrl-C stops it rather than Dazza. */
  cancelBusy: (() => void) | undefined;
  /** The line being read stops a reply on Esc, so the status line can say so. */
  private interruptible = false;
  /** What's been pasted so far, while a paste is arriving. */
  private pasting: string | undefined;
  /** Keys typed while nothing was reading them, e.g. during a command. */
  private readonly typedAhead: Key[] = [];

  constructor() {
    if (this.interactive) {
      emitKeypressEvents(stdin);
      this.takeInput();
    }
  }

  /**
   * Write output above the input line. Whatever the user is typing is redrawn
   * underneath, so Dazza can report work while they keep typing.
   */
  print(text: string): void {
    // Wrap at word boundaries: the terminal would otherwise break words in half.
    const shown = this.interactive ? wrap(text, (stdout.columns || 80) - 1) : text;
    if (!this.interactive || !this.redrawInput) {
      stdout.write(`${shown}\n`);
      return;
    }
    this.erase();
    stdout.write(`${shown}\n`);
    this.redrawInput();
  }

  /**
   * Show (or clear) an activity in the status line above the input, e.g.
   * "Building T3". A function is asked again at every redraw, for a countdown.
   */
  setStatus(key: string, text: StatusText | undefined): void {
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

  /**
   * Show text being written (a streaming reply's unfinished line) just above
   * the status line, until it's printed for good. Undefined clears it.
   */
  setDraft(text: string | undefined): void {
    this.draft = text;
    if (!this.interactive) return;
    this.redrawInput?.();
  }

  /** What's drawn above the input: a streaming reply's unfinished line, then the status line. */
  private aboveInput(): string[] {
    const status = this.statusLine();
    return status ? [...this.draftLines(), status] : this.draftLines();
  }

  /** The draft, wrapped, and only its last few lines if it's long. */
  private draftLines(): string[] {
    if (!this.draft) return [];
    return wrap(this.draft, (stdout.columns || 80) - 1)
      .split('\n')
      .slice(-MAX_DRAFT_LINES);
  }

  /** The status line as it should look right now, or undefined when idle. */
  private statusLine(): string | undefined {
    if (this.statuses.size === 0) return undefined;
    const now = Date.now();
    const parts = [...this.statuses.entries()].map(([key, { text, since }]) => {
      const seconds = Math.floor((now - since) / 1000);
      const elapsed =
        seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      const hint = key === 'chat' && this.interruptible ? ' · esc to interrupt' : '';
      return `${typeof text === 'function' ? text() : text} ${paint.dim(`· ${elapsed}${hint}`)}`;
    });
    const line = `${paint.hex(BRAND, FRAMES[this.frame % FRAMES.length] ?? '')} ${parts.join(paint.dim('  ·  '))}`;
    // One row, always: a status the terminal wraps throws every redraw off by a line.
    return clipVisible(line, (stdout.columns || 80) - 1);
  }

  private erase(): void {
    stdout.write(`${this.drawnCursorRow > 0 ? `\x1b[${this.drawnCursorRow}A` : ''}\r\x1b[J`);
    this.drawnCursorRow = 0;
  }

  /** Give up on the line being read, as if cancelled: the terminal is going away. */
  cancelRead(): void {
    const reading = this.onKey;
    if (!reading) return;
    // Ctrl-C clears a half-typed line first; a second one on the empty line cancels.
    reading({ ctrl: true, name: 'c' });
    if (this.onKey === reading) reading({ ctrl: true, name: 'c' });
  }

  /** Read one line. Resolves undefined when the user cancels (Ctrl-C / Ctrl-D on empty). */
  async readLine(options: ReadOptions): Promise<string | undefined> {
    if (!this.interactive) return this.nextLine(options.prompt);

    let state = initialState(options.history);
    const menuFor: MenuSource = options.menu ?? (() => []);
    this.interruptible = options.onInterrupt !== undefined;
    const redraw = (showMenu = true) =>
      this.draw(
        layout(
          options.prompt,
          state,
          showMenu ? menuFor(state.text) : [],
          options.mask,
          undefined,
          this.aboveInput(),
        ),
      );
    this.redrawInput = redraw;
    redraw();

    return new Promise((resolve) => {
      const onResize = () => redraw();
      stdout.on('resize', onResize);
      this.onKey = (key) => {
        // Ctrl+V with an image on the clipboard (text pastes arrive as a paste, not Ctrl+V).
        if (key.ctrl && key.name === 'v' && options.pasteImage) {
          void options.pasteImage().then((text) => {
            if (text) this.onKey?.({ name: 'paste', sequence: text });
          });
          return;
        }
        if (key.name === 'escape' && !state.text && options.onInterrupt) {
          options.onInterrupt();
          return;
        }
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
        if (options.mask) {
          this.draw(layout(options.prompt, state, [], options.mask));
          stdout.write('\n');
        } else {
          // Set apart from Dazza's words, rewrapped now it's no longer being edited.
          stdout.write(`\r\x1b[J${userMessage(state.text, (stdout.columns || 80) - 1)}\n`);
        }
        this.drawnCursorRow = 0;
        this.onKey = undefined;
        stdout.off('resize', onResize);
        resolve(outcome.type === 'submit' ? outcome.value : undefined);
      };
      this.replayTypedAhead();
    });
  }

  /**
   * Keys typed while nothing was reading (say, "/stop" during a command) go in
   * first. An Enter among them submits, and what follows waits for the next prompt.
   */
  private replayTypedAhead(): void {
    while (this.onKey && this.typedAhead.length > 0) {
      const key = this.typedAhead.shift();
      if (key) this.onKey(key);
    }
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
    // Every row fits on one line: a row the terminal wraps throws the redraw off.
    const width = Math.max(20, (stdout.columns || 80) - 1);
    const labelWidth = Math.min(Math.max(...choices.map((c) => c.label.length)), width - 4);
    const redraw = (final = false, cancelled = false) => {
      const rows = choices.map((c, i) => {
        const active = i === index && !final;
        const marker = active ? paint.hex(BRAND, '›') : ' ';
        const padded = clip(c.label, labelWidth).padEnd(labelWidth);
        const label = c.disabled ? paint.dim(padded) : active ? paint.bold(padded) : padded;
        const room = width - 4 - labelWidth - 3;
        const hint = c.hint && room >= 8 ? `   ${paint.dim(clip(c.hint, room))}` : '';
        return `  ${marker} ${label}${hint}`;
      });
      // A hint cut short to fit: the highlighted one in full, underneath.
      const fullHint = () => {
        const hint = choices[index]?.hint;
        const room = width - 4 - labelWidth - 3;
        if (!hint || (room >= 8 && hint.length <= room)) return [];
        return wrap(hint, width - 4)
          .split('\n')
          .map((line) => `    ${paint.dim(line)}`);
      };
      const picked = cancelled ? undefined : choices[index];
      const asked = wrap(question, width)
        .split('\n')
        .map((line) => paint.bold(line));
      const lines = final
        ? wrap(`${question} ${picked?.label ?? ''}`.trimEnd(), width)
            .split('\n')
            .map((line, i, all) =>
              i === all.length - 1 && picked && line.endsWith(picked.label)
                ? `${paint.bold(line.slice(0, -picked.label.length))}${paint.dim(picked.label)}`
                : paint.bold(line),
            )
        : [...asked, ...rows, ...fullHint()];
      // wrap() never breaks a long word (a path, a URL): clip anything still too wide.
      const fitted = lines.map((line) => clipVisible(line, width));
      this.draw({ lines: fitted, cursorRow: fitted.length - 1, cursorCol: 0 });
    };
    stdout.write('\x1b[?25l'); // hide the cursor while picking
    redraw();
    // Output while picking (a build going on) is printed above the list, which
    // is then drawn again below it, rather than written over it.
    const previous = this.redrawInput;
    this.redrawInput = () => redraw();

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
        this.redrawInput = previous;
        redraw(true, value === undefined);
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

  /**
   * Give the terminal to a child process (e.g. an interactive sign-in), then
   * take it back. Dazza stops reading stdin meanwhile, so it can't swallow what
   * the user types into the child.
   */
  async handOver<T>(work: () => Promise<T>): Promise<T> {
    if (!this.interactive) return work();
    this.releaseInput();
    try {
      return await work();
    } finally {
      this.takeInput();
    }
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.interactive) this.releaseInput();
    this.rl?.close();
  }

  private takeInput(): void {
    stdin.setRawMode(true);
    stdin.on('keypress', this.handleKey);
    stdin.resume();
    stdout.write(PASTE_MODE_ON);
  }

  private releaseInput(): void {
    stdout.write(PASTE_MODE_OFF);
    stdin.off('keypress', this.handleKey);
    stdin.setRawMode(false);
    stdin.pause();
  }

  private handleKey = (_: string | undefined, key: Key | undefined) => {
    const pressed = key ?? {};
    // A paste arrives as keys between two markers: gather it, then hand it over whole.
    if (pressed.name === 'paste-start') {
      this.pasting = '';
      return;
    }
    if (this.pasting !== undefined) {
      if (pressed.name !== 'paste-end') {
        this.pasting +=
          pressed.name === 'return' || pressed.name === 'enter' ? '\n' : (pressed.sequence ?? '');
        return;
      }
      const text = this.pasting;
      this.pasting = undefined;
      const paste = { name: 'paste', sequence: text };
      if (this.onKey) this.onKey(paste);
      else this.typedAhead.push(paste);
      return;
    }
    if (this.onKey) this.onKey(pressed);
    // Something the user started can be stopped on its own (a `!` command).
    else if (pressed.ctrl && pressed.name === 'c' && this.cancelBusy) this.cancelBusy();
    // Nothing is being read (starting up, or running a command): Ctrl-C quits.
    else if (pressed.ctrl && pressed.name === 'c') this.quit();
    // Anything else typed meanwhile is kept for the next prompt, as a shell would.
    else if (this.typedAhead.length < MAX_TYPED_AHEAD) this.typedAhead.push(pressed);
  };

  /**
   * Stop Dazza and everything it started, as Ctrl-C would outside raw mode
   * (raw mode means the terminal won't send the signal itself).
   */
  private quit(): void {
    this.close();
    stdout.write('\x1b[?25h\n');
    // Exiting (rather than dying to a signal) runs the exit hooks that stop
    // the agents and app servers Dazza started.
    process.exit(130);
  }

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
  /** Lines drawn above the input: a reply as it's written, the activity line. */
  status?: string | string[],
): Layout {
  // One column spare so the terminal never auto-wraps behind our back.
  const width = Math.max(10, columns - 1);
  const promptWidth = visibleLength(prompt);
  const text = mask ? '•'.repeat(state.text.length) : state.text;

  // Long lines wrap at the edge; typed line breaks start a new line under the text.
  const indent = ' '.repeat(promptWidth);
  const lines: string[] = [prompt];
  let row = 0;
  let col = promptWidth;
  let cursorRow = 0;
  let cursorCol = promptWidth;
  for (let i = 0; i <= text.length; i++) {
    if (i === state.cursor) {
      cursorRow = row;
      cursorCol = col;
    }
    const char = text[i];
    if (char === undefined) break;
    if (char === '\n') {
      lines.push(indent);
      row++;
      col = promptWidth;
      continue;
    }
    if (col >= width) {
      lines.push('');
      row++;
      col = 0;
    }
    lines[row] += char;
    col++;
  }
  if (cursorCol >= width) {
    // The cursor sits just past a full line: it goes at the start of the next.
    cursorRow++;
    cursorCol = 0;
    if (cursorRow >= lines.length) lines.push('');
  }

  if (menu.length > 0) lines.push(...menuLines(menu, state.menuIndex, width));
  const above = status === undefined ? [] : Array.isArray(status) ? status : [status];
  return { lines: [...above, ...lines], cursorRow: cursorRow + above.length, cursorCol };
}

function menuLines(menu: MenuItem[], selectedIndex: number, width: number): string[] {
  const selected = Math.min(selectedIndex, menu.length - 1);
  // Keep the highlighted item in view when the list is longer than the window.
  const start = Math.max(0, Math.min(selected - MAX_MENU_ITEMS + 1, menu.length - MAX_MENU_ITEMS));
  const shown = menu.slice(start, start + MAX_MENU_ITEMS);
  const shownAs = (item: MenuItem) => item.label ?? item.value;
  const valueWidth = Math.max(...menu.map((m) => shownAs(m).length)) + 2;

  return shown.map((item, i) => {
    const active = start + i === selected;
    const hint = truncate(item.hint, Math.max(0, width - valueWidth - 4));
    const value = truncate(shownAs(item), width - 4).padEnd(valueWidth);
    return active
      ? `  ${paint.hex(BRAND, paint.bold(value))}${hint}`
      : `  ${paint.dim(value)}${paint.dim(hint)}`;
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Cut plain text to `max` characters, with an ellipsis if it was longer. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Cut text with colour codes to `max` visible characters, ending in an
 * ellipsis if it was longer; the codes are kept, and colour reset at the cut.
 */
export function clipVisible(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  let out = '';
  let shown = 0;
  for (let i = 0; i < text.length; ) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: keeping ANSI codes intact.
    const code = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    if (shown === max - 1) return `${out}…\x1b[0m`;
    out += text[i];
    shown++;
    i++;
  }
  return out;
}

function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes.
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Wrap text to a width at word boundaries, keeping each line's indent on the
 * lines it wraps onto. Colour codes don't count towards the width.
 */
/**
 * What the user sent, as it stays on screen: a shaded band the width of the
 * terminal, so it doesn't blend into Dazza's replies. Plain `›` lines when
 * colour is off.
 */
export function userMessage(text: string, width: number): string {
  const inner = Math.max(10, width - 2);
  const lines = text
    .split('\n')
    .map((line, i) => `${i === 0 ? '›' : ' '} ${line}`)
    .flatMap((line) => wrap(line, inner).split('\n'));
  // Without colour there's no band to fill, so no padding either.
  if (paint.band('') === '') return lines.join('\n');
  return lines.map((line) => paint.band(` ${line.padEnd(inner)} `)).join('\n');
}

export function wrap(text: string, width: number): string {
  if (width < 20) return text;
  return text
    .split('\n')
    .map((line) => {
      if (visibleLength(line) <= width) return line;
      // Continue under the text, not under a leading marker or bullet ("● ", "- ").
      const lead = /^\s*(?:[^\w\s]\s)?/.exec(line.replace(ANSI, ''))?.[0] ?? '';
      const indent = ' '.repeat(lead.length);
      const words = line.trimStart().split(' ');
      const lines: string[] = [];
      let current = line.slice(0, line.length - line.trimStart().length);
      for (const word of words) {
        const candidate = current.trim() ? `${current} ${word}` : `${current}${word}`;
        if (visibleLength(candidate) > width && current.trim()) {
          lines.push(current);
          current = `${indent}${word}`;
        } else {
          current = candidate;
        }
      }
      lines.push(current);
      return lines.join('\n');
    })
    .join('\n');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape codes.
const ANSI = /\x1b\[[0-9;]*m/g;
