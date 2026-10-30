/** Conservative terminal-cell width used before Ink performs physical layout. */
export const terminalTextWidth = (value) => Array.from(value).reduce((columns, point) => columns + (point.codePointAt(0) > 0x7f ? 2 : 1), 0);
export const truncateTerminalText = (value, maxColumns) => {
    if (terminalTextWidth(value) <= maxColumns)
        return value;
    const ellipsis = '…';
    const ellipsisWidth = terminalTextWidth(ellipsis);
    if (maxColumns <= ellipsisWidth)
        return ellipsis;
    let rendered = '';
    for (const point of value) {
        if (terminalTextWidth(rendered) + terminalTextWidth(point) + ellipsisWidth > maxColumns)
            break;
        rendered += point;
    }
    return `${rendered}${ellipsis}`;
};
//# sourceMappingURL=terminal-text-budget.js.map