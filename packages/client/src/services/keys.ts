/** One-shot modifiers armed from the extra-keys bar; they apply to the next keystroke from any source. */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

export function hasModifiers(mods: Modifiers): boolean {
  return mods.ctrl || mods.alt;
}

const ESC = '\x1b';

/** Ctrl combinations for non-letters, as xterm encodes them. */
const CTRL_SYMBOLS: Record<string, string> = {
  '@': '\x00', ' ': '\x00', '2': '\x00',
  '[': '\x1b', '3': '\x1b',
  '\\': '\x1c', '4': '\x1c',
  ']': '\x1d', '5': '\x1d',
  '^': '\x1e', '6': '\x1e',
  '_': '\x1f', '/': '\x1f', '7': '\x1f',
  '?': '\x7f', '8': '\x7f',
};

// Cursor and navigation keys in CSI (`ESC [ A`) or SS3 (`ESC O A`, application cursor mode) form.
const CURSOR_KEY = /^\x1b[[O]([A-DHF])$/;
// Tilde keys such as PgUp (`ESC [ 5 ~`), PgDn, Insert, Delete.
const TILDE_KEY = /^\x1b\[(\d+)~$/;

/** xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). */
function modifierParam(mods: Modifiers): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

function ctrlOf(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40);
  return CTRL_SYMBOLS[char] ?? char;
}

/**
 * Encode one keystroke with the armed modifiers, following xterm conventions:
 * Ctrl maps a character to its control code, Alt prefixes ESC, and cursor or
 * tilde keys get a modifier parameter (Ctrl+Up is `ESC [ 1 ; 5 A`).
 * Input that is not a single keystroke (a paste, IME text) is returned unchanged.
 */
export function applyModifiers(data: string, mods: Modifiers): string {
  if (!hasModifiers(mods)) return data;

  const cursor = CURSOR_KEY.exec(data);
  if (cursor) return `${ESC}[1;${modifierParam(mods)}${cursor[1]}`;

  const tilde = TILDE_KEY.exec(data);
  if (tilde) return `${ESC}[${tilde[1]};${modifierParam(mods)}~`;

  if ([...data].length !== 1) return data;

  const base = mods.ctrl ? ctrlOf(data) : data;
  return mods.alt ? ESC + base : base;
}
