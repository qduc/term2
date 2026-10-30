import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import { Hairline, RAIL_HEAVY, RAIL_THIN, Rail } from './parts.js';
/**
 * The question sits behind a heavy warning rail, like an approval; its options are
 * the same numbered list the approval uses, the selected one explained in one dim
 * line under the list rather than in a side pane.
 */
export const RailQuestionPrompt = ({ progress, question, notice, options, description, footer, }) => {
    const theme = useTheme();
    return (React.createElement(Rail, { glyph: RAIL_HEAVY, color: theme.warning },
        progress !== undefined && React.createElement(Text, { color: theme.textSubtle }, progress),
        React.createElement(Text, { bold: true, color: theme.warning }, question),
        notice !== undefined && React.createElement(Text, { color: theme.accent },
            "\u276F ",
            notice),
        React.createElement(Box, { flexDirection: "column", marginTop: 1 }, options.map((option, index) => {
            const tone = option.tone ? theme[option.tone] : undefined;
            const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
            return (React.createElement(Box, { key: option.label },
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.accent, bold: true }, option.selected ? GLYPH_SELECTED : ' ')),
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.textSubtle }, option.recommended ? GLYPH_FAVORITE : ' ')),
                React.createElement(Box, { flexShrink: 1 },
                    React.createElement(Text, { color: option.selected ? tone : theme.textMuted, bold: option.selected },
                        index + 1,
                        ". ",
                        checkbox,
                        option.label))));
        })),
        description.text && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.textSubtle, italic: true }, description.text))),
        React.createElement(Box, { marginTop: 1 }, footer)));
};
/** A thin rail in the status colour down the whole feed, so it reads as one unit apart from the answer. */
export const RailSubagentFeed = ({ title, statusSuffix, tone, summary, children }) => {
    const theme = useTheme();
    return (React.createElement(Rail, { glyph: RAIL_THIN, color: theme[tone] },
        React.createElement(Text, { color: theme[tone], bold: true },
            title,
            statusSuffix),
        summary !== undefined ? React.createElement(Text, { color: theme.textSubtle }, summary) : children));
};
/**
 * Renderer bodies always sit inside the tool call's own rail, so a second rail here
 * would double it. Rows and content blocks indent; a callout opens with a bold
 * heading in its tone.
 */
export const RailToolSection = ({ variant, title, tone = 'warning', children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", paddingLeft: 2 },
        variant === 'callout' && title !== undefined && (React.createElement(Text, { color: theme[tone], bold: true }, title)),
        children));
};
/** Hairlines above and below, no box; a state colour (error) tints the title instead of a border. */
export const RailMenuFrame = ({ title, borderColor, footer, footerPlacement, children }) => {
    const theme = useTheme();
    const footerNode = footer ? (typeof footer === 'string' ? (React.createElement(Text, { color: theme.textSubtle }, footer)) : (footer)) : null;
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(Hairline, null),
        title ? (React.createElement(Text, { bold: true, color: borderColor === theme.danger ? theme.danger : theme.textMuted }, title)) : null,
        children,
        footerPlacement === 'inside' && footerNode,
        React.createElement(Hairline, null),
        footerPlacement === 'outside' && footerNode));
};
//# sourceMappingURL=body.js.map