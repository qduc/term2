import type { Key } from 'ink';

/** Shift+Tab arrives as a modified Tab or, on terminals Ink does not decode, as the raw `ESC [ Z` sequence. */
export const isShiftTab = (input: string, key: Key): boolean => (key.shift && key.tab) || input === '\x1b[Z';

/** Ctrl+G arrives as a ctrl-modified `g` or, on terminals Ink does not decode, as the raw BEL byte. */
export const isCtrlG = (input: string, key: Key): boolean => (key.ctrl && input === 'g') || input === '\x07';

/** Ctrl+O arrives as a ctrl-modified `o` or, on terminals Ink does not decode, as the raw SI byte. */
export const isCtrlO = (input: string, key: Key): boolean =>
  (key.ctrl && input.toLowerCase() === 'o') || input === '\x0f';

/** Ctrl+T arrives as a ctrl-modified `t` or, on terminals Ink does not decode, as the raw DC4 byte. */
export const isCtrlT = (input: string, key: Key): boolean => (key.ctrl && input === 't') || input === '\x14';
