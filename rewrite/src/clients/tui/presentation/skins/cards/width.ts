/**
 * Terminal cells a string occupies, for laying out chips and pills before Ink measures them.
 *
 * `terminalTextWidth` counts every non-ASCII code point as two cells, which is the safe
 * default for arbitrary text but doubles the box-drawing and gauge glyphs these layouts
 * are made of. This counts those as one and only the genuinely wide ranges (CJK,
 * fullwidth forms, emoji) as two.
 */
const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff);

export const cells = (value: string): number =>
  Array.from(value).reduce((columns, char) => columns + (isWide(char.codePointAt(0)!) ? 2 : 1), 0);

/** Clips to `maxCells`, ending in an ellipsis when it had to cut. */
export const clip = (value: string, maxCells: number): string => {
  if (cells(value) <= maxCells) return value;
  if (maxCells <= 1) return '…';
  let out = '';
  for (const char of value) {
    if (cells(out) + cells(char) + 1 > maxCells) break;
    out += char;
  }
  return `${out}…`;
};
