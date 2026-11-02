/**
 * Terminal columns a string occupies, for the few places zen has to decide a
 * layout before Ink does (does the approval fit on one line, how much of the
 * status line can stay).
 *
 * `terminalTextWidth` deliberately counts every non-ASCII code point as two cells,
 * which would make zen's own glyphs (`›`, `◆`, `·`, `—`, `▲`) cost double and push
 * it into its narrow layouts far too early. Those are single cells in every
 * terminal this app targets; only genuinely wide scripts and emoji are doubled.
 */
export function cells(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}
