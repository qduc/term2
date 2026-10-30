import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import { Chip } from './chip.js';
/** A solid `ASK` chip leads the question; options are rows with a fixed-width number column. */
export const LedgerQuestionPrompt = ({ progress, question, notice, options, description, footer, }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Chip, { solid: true, tone: "warning" }, "ASK")),
            React.createElement(Box, { flexShrink: 1 },
                React.createElement(Text, { bold: true }, question))),
        progress !== undefined && React.createElement(Text, { color: theme.textSubtle }, progress),
        notice !== undefined && React.createElement(Text, { color: theme.accent },
            "\u276F ",
            notice),
        options.map((option, index) => {
            const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
            return (React.createElement(Box, { key: option.label },
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.accent, bold: true }, option.selected ? GLYPH_SELECTED : ' ')),
                React.createElement(Box, { width: 3, flexShrink: 0 },
                    React.createElement(Text, { color: option.tone ? theme[option.tone] : theme.textSubtle, bold: true }, index + 1)),
                React.createElement(Box, { flexShrink: 1 },
                    React.createElement(Text, { color: option.selected && option.tone ? theme[option.tone] : undefined, bold: option.selected },
                        checkbox,
                        option.label,
                        option.recommended ? ` ${GLYPH_FAVORITE}` : ''))));
        }),
        description.text !== undefined && description.text !== '' && (React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Text, { color: theme.textSubtle }, "\u21B3")),
            React.createElement(Text, { color: theme.textSubtle }, description.text))),
        React.createElement(Box, { marginTop: 1 }, footer)));
};
/** An `AGENT` chip and the task on one line; its latest calls indented beneath. */
export const LedgerSubagentFeed = ({ title, statusSuffix, tone, summary, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Chip, { tone: tone, bold: true }, "AGENT")),
            React.createElement(Box, { flexShrink: 1 },
                React.createElement(Text, { color: theme[tone] },
                    title,
                    statusSuffix))),
        React.createElement(Box, { flexDirection: "column", paddingLeft: 2 }, summary !== undefined ? React.createElement(Text, { color: theme.textSubtle }, summary) : children)));
};
/** Rows indent; a panel hangs off a `│` margin; a callout opens with a chip. */
export const LedgerToolSection = ({ variant, title, tone = 'warning', children }) => {
    const theme = useTheme();
    if (variant === 'indent') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: 2 }, children));
    }
    if (variant === 'panel') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: 1, marginLeft: 1, borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, borderColor: theme.border }, children));
    }
    return (React.createElement(Box, { flexDirection: "column", paddingLeft: 1 },
        title !== undefined && (React.createElement(Box, { alignSelf: "flex-start" },
            React.createElement(Chip, { solid: true, tone: tone }, title))),
        children));
};
/** A square box, title as a chip on its first line, hints under a hairline or below. */
export const LedgerMenuFrame = ({ title, borderColor, footer, footerPlacement, children }) => {
    const theme = useTheme();
    const footerNode = footer ? (typeof footer === 'string' ? (React.createElement(Text, { color: theme.textSubtle }, footer)) : (footer)) : null;
    const body = (React.createElement(Box, { borderStyle: "single", borderColor: borderColor ?? theme.borderActive, paddingX: 1, flexDirection: "column", width: "100%" },
        title ? (React.createElement(Box, { alignSelf: "flex-start" },
            React.createElement(Chip, { tone: "textMuted", bold: true }, title))) : null,
        children,
        footerPlacement === 'inside' && footerNode && React.createElement(Box, { marginTop: 1 }, footerNode)));
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        body,
        footerPlacement === 'outside' && footerNode));
};
//# sourceMappingURL=body.js.map