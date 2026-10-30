import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
import { cells } from './width.js';
const SELECTED_MARKER = '›';
const OPTION_SEPARATOR = '  ·  ';
/**
 * No box and no rail: an interruption is a sentence, then a blank line, then the
 * thing being asked about, indented under it. Zen has no chrome to make the
 * riskiest class loud, so that class is told apart by shape: a `▲` ahead of the
 * sentence and a heavy `┃` rule down the left of everything it covers. Both survive
 * a terminal with no colour.
 */
export const ZenApprovalFrame = ({ tone, header, subheader, children }) => {
    const theme = useTheme();
    const { colourless } = useZenStyles();
    const danger = tone === 'danger';
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, null,
            danger && (React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
                React.createElement(Text, { color: theme.danger, bold: true }, "\u25B2"))),
            React.createElement(Text, { color: danger ? theme.danger : theme.warning, bold: danger && colourless }, header)),
        subheader !== undefined && subheader !== null && (React.createElement(Box, { paddingLeft: danger ? MARKER_COLUMNS - 1 : MARKER_COLUMNS }, subheader)),
        danger ? (React.createElement(Box, { flexDirection: "column", borderStyle: "bold", borderTop: false, borderBottom: false, borderRight: false, borderColor: theme.danger, paddingLeft: 1 }, children)) : (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS }, children))));
};
/**
 * The question as a sentence, then the answers on one line, `1 Allow once  ·  2 Deny`,
 * with the number keys visible. The selected answer is bold, in its own tone, and
 * carries a `›`. When the answers do not fit on one line (a narrow terminal, or a
 * menu of four long labels) they stack, one per row, with the same markers. The
 * selected answer's explanation is one dim line beneath, so choosing never needs a
 * second pane.
 */
export const ZenApprovalChoices = ({ question, options, selectedIndex, layout, description, }) => {
    const theme = useTheme();
    const { faint, quiet } = useZenStyles();
    const columns = useTerminalColumns();
    // The frame indents its body, and the options sit inside it.
    const available = Math.max(1, columns - MARKER_COLUMNS - 2);
    const inlineWidth = options.reduce((total, option, index) => total + cells(`${index + 1} ${option.label}`), 0) +
        cells(OPTION_SEPARATOR) * Math.max(0, options.length - 1) +
        cells(`${SELECTED_MARKER} `);
    const inline = layout === 'two-pane' && inlineWidth <= available;
    const label = (option, index) => {
        const selected = index === selectedIndex;
        return (React.createElement(Text, { color: selected ? theme[option.tone] : undefined, bold: selected },
            React.createElement(Text, { ...(selected ? { color: theme[option.tone] } : faint) }, index + 1),
            " ",
            option.label));
    };
    const explanation = layout === 'two-pane' && description?.text ? (React.createElement(Box, { paddingLeft: inline ? MARKER_COLUMNS : MARKER_COLUMNS * 2 },
        React.createElement(Text, { ...quiet }, description.text))) : null;
    return (React.createElement(React.Fragment, null,
        question !== undefined && React.createElement(Text, null, question),
        inline ? (React.createElement(Box, null, options.map((option, index) => (React.createElement(React.Fragment, { key: option.label },
            index > 0 && React.createElement(Text, { ...faint }, OPTION_SEPARATOR),
            index === selectedIndex && (React.createElement(Text, { color: theme[option.tone], bold: true },
                SELECTED_MARKER,
                ' ')),
            label(option, index)))))) : (options.map((option, index) => (React.createElement(Box, { key: option.label },
            React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 }, index === selectedIndex && (React.createElement(Text, { color: theme[option.tone], bold: true }, SELECTED_MARKER))),
            label(option, index))))),
        explanation));
};
//# sourceMappingURL=approval.js.map