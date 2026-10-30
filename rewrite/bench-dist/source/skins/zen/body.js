import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, useTheme } from '../../components/theme.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
/**
 * A sentence, then the choices, indented under it: no box and no rail. The selected
 * row takes a `›` and is bold, which is what carries it in `mono`.
 */
export const ZenQuestionPrompt = ({ progress, question, notice, options, description, footer, }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, null,
            React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
                React.createElement(Text, { color: theme.warning, bold: true }, "?")),
            React.createElement(Text, { bold: true },
                question,
                progress !== undefined && (React.createElement(Text, { color: faint.color, dimColor: faint.dimColor, bold: false },
                    '  ',
                    "(",
                    progress,
                    ")")))),
        notice !== undefined && (React.createElement(Box, { paddingLeft: MARKER_COLUMNS },
            React.createElement(Text, { color: theme.accent }, notice))),
        React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS, marginTop: 1 }, options.map((option, index) => {
            const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
            return (React.createElement(Box, { key: option.label },
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.accent, bold: true }, option.selected ? '›' : ' ')),
                React.createElement(Box, { flexShrink: 1 },
                    React.createElement(Text, { color: option.selected && option.tone ? theme[option.tone] : undefined, bold: option.selected },
                        index + 1,
                        ". ",
                        checkbox,
                        option.label,
                        option.recommended ? ` ${GLYPH_FAVORITE}` : ''))));
        })),
        description.text && (React.createElement(Box, { paddingLeft: MARKER_COLUMNS, marginTop: 1 },
            React.createElement(Text, { color: faint.color, dimColor: faint.dimColor, italic: true }, description.text))),
        React.createElement(Box, { paddingLeft: MARKER_COLUMNS, marginTop: 1 }, footer)));
};
/** One quiet line for the task, its latest calls indented under it. Only a failure is coloured. */
export const ZenSubagentFeed = ({ title, statusSuffix, status, tone, summary, children }) => {
    const theme = useTheme();
    const { quiet, colourless } = useZenStyles();
    const failed = tone === 'danger';
    const glyph = failed ? '✗' : status === 'completed' ? '✓' : '↳';
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, null,
            React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
                React.createElement(Text, { color: failed ? theme.danger : quiet.color, dimColor: !failed && quiet.dimColor }, glyph)),
            React.createElement(Text, { color: failed ? theme.danger : quiet.color, dimColor: !failed && quiet.dimColor, bold: failed && colourless },
                title,
                statusSuffix)),
        React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS }, summary !== undefined ? (React.createElement(Text, { color: quiet.color, dimColor: quiet.dimColor }, summary)) : (children))));
};
/** Everything is indent; a panel gets a quiet `│` margin and a callout a bold heading, with no boxes. */
export const ZenToolSection = ({ variant, title, tone = 'warning', children }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    if (variant === 'indent') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS }, children));
    }
    if (variant === 'panel') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: 1, marginLeft: MARKER_COLUMNS - 1, borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, borderColor: faint.color, borderDimColor: faint.dimColor }, children));
    }
    return (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS },
        title !== undefined && (React.createElement(Text, { color: theme[tone], bold: true }, title)),
        children));
};
/** No border at all: a faint title, the rows, the hints. An error colours the title, not a frame. */
export const ZenMenuFrame = ({ title, borderColor, footer, footerPlacement, children }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    const footerNode = footer ? typeof footer === 'string' ? React.createElement(Text, { color: faint.color }, footer) : footer : null;
    const alarmed = borderColor === theme.danger;
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        title ? (React.createElement(Text, { color: alarmed ? theme.danger : faint.color, dimColor: !alarmed && faint.dimColor, bold: alarmed && faint.dimColor }, title)) : null,
        children,
        footerNode && React.createElement(Box, { marginTop: footerPlacement === 'inside' ? 1 : 0 }, footerNode)));
};
//# sourceMappingURL=body.js.map