/** Conservative terminal-cell width used before Ink performs physical layout. */
export const terminalTextWidth = (value: string): number =>
  Array.from(value).reduce((columns, point) => columns + (point.codePointAt(0)! > 0x7f ? 2 : 1), 0);

export const truncateTerminalText = (value: string, maxColumns: number): string => {
  if (terminalTextWidth(value) <= maxColumns) return value;
  const ellipsis = '…';
  const ellipsisWidth = terminalTextWidth(ellipsis);
  if (maxColumns <= ellipsisWidth) return ellipsis;
  let rendered = '';
  for (const point of value) {
    if (terminalTextWidth(rendered) + terminalTextWidth(point) + ellipsisWidth > maxColumns) break;
    rendered += point;
  }
  return `${rendered}${ellipsis}`;
};
