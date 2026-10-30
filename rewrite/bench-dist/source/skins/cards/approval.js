import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SELECTED, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { Card } from './card.js';
import { useMeasuredWidth } from './measure.js';
import { cells } from './width.js';
/** Border and padding on both sides of the approval card. */
const CARD_CHROME = 4;
/** Below this terminal width the options always stack, whatever their length. */
const STACK_BELOW_COLUMNS = 60;
/** Columns a chip spends outside its label: a space either side, the marker slot, and `N `. */
const CHIP_CHROME = 2 + 2 + 2;
/**
 * A titled box in the warning colour. The riskiest class changes shape (a double
 * border) and gains a `▲`, so it is recognisable before any word is read and with no
 * colour at all; the ordinary class keeps the rounded shape of every other card.
 */
export const CardsApprovalFrame = ({ tone, header, subheader, children }) => {
    const theme = useTheme();
    const danger = tone === 'danger';
    const color = danger ? theme.danger : theme.warning;
    return (React.createElement(Card, { color: color, shape: danger ? 'double' : 'round', title: React.createElement(Text, { color: color, bold: true, wrap: "truncate-end" },
            danger ? `${GLYPH_WARNING} ` : '',
            "Approval needed") },
        React.createElement(Text, { bold: true }, header),
        subheader,
        children));
};
/**
 * One option as a button. The selected one is filled (reverse video in the option's
 * own tone, so its text is always the terminal's background colour on that tone, which
 * is readable on any palette) and carries a `❯`; the others sit on a quiet surface. The
 * marker slot is reserved on every chip so selecting never shifts the row.
 */
const Chip = ({ index, option, selected }) => {
    const theme = useTheme();
    if (selected) {
        return (React.createElement(Text, { inverse: true, bold: true, color: theme[option.tone] }, ` ${GLYPH_SELECTED} ${index + 1} ${option.label} `));
    }
    return (React.createElement(Text, { backgroundColor: theme.codeBackground, color: theme.text },
        '   ',
        React.createElement(Text, { color: theme[option.tone], bold: true }, index + 1),
        ` ${option.label} `));
};
/**
 * The question, then the options as a row of chips with the selected option's
 * description under them. When the row would not fit, or the terminal is narrow, the
 * same chips stack one per line instead of overflowing.
 */
export const CardsApprovalChoices = ({ question, options, selectedIndex, layout, description, }) => {
    const theme = useTheme();
    const terminalColumns = useTerminalColumns();
    // The room the chips actually have is the card's inner width, which is measured.
    const [measureRef, innerWidth] = useMeasuredWidth(terminalColumns - CARD_CHROME, terminalColumns);
    const rowWidth = options.reduce((total, option, index) => total + CHIP_CHROME + String(index + 1).length - 1 + cells(option.label), 0) + Math.max(0, options.length - 1);
    const horizontal = innerWidth + CARD_CHROME >= STACK_BELOW_COLUMNS && rowWidth <= innerWidth;
    const chips = options.map((option, index) => (React.createElement(Chip, { key: option.label, index: index, option: option, selected: index === selectedIndex })));
    return (React.createElement(Box, { flexDirection: "column", ref: measureRef },
        question !== undefined && React.createElement(Text, { bold: true }, question),
        horizontal ? (React.createElement(Box, { columnGap: 1, flexWrap: "wrap", marginTop: question === undefined ? 0 : 1 }, chips)) : (React.createElement(Box, { flexDirection: "column", marginTop: question === undefined ? 0 : 1 }, chips.map((chip, index) => (React.createElement(Box, { key: options[index].label }, chip))))),
        layout === 'two-pane' && description?.text && React.createElement(Text, { color: theme.textSubtle }, description.text)));
};
//# sourceMappingURL=approval.js.map