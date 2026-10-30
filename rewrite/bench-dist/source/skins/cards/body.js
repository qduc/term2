import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import { Card } from './card.js';
/** The question is the card's content; options are rows inside it, the selected one in its tone and bold. */
export const CardsQuestionPrompt = ({ progress, question, notice, options, description, footer, }) => {
    const theme = useTheme();
    return (React.createElement(Card, { color: theme.warning, title: React.createElement(Text, { color: theme.warning, bold: true, wrap: "truncate-end" }, progress ?? 'Question') },
        React.createElement(Text, { bold: true }, question),
        notice !== undefined && React.createElement(Text, { color: theme.accent },
            "\u276F ",
            notice),
        React.createElement(Box, { flexDirection: "column", marginTop: 1 }, options.map((option, index) => {
            const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
            return (React.createElement(Box, { key: option.label },
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.accent, bold: true }, option.selected ? GLYPH_SELECTED : ' ')),
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.textSubtle }, option.recommended ? GLYPH_FAVORITE : ' ')),
                React.createElement(Box, { flexShrink: 1 },
                    React.createElement(Text, { color: option.selected && option.tone ? theme[option.tone] : undefined, bold: option.selected, inverse: option.selected && option.tone === undefined },
                        index + 1,
                        ". ",
                        checkbox,
                        option.label))));
        })),
        description.text && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.textSubtle }, description.text))),
        React.createElement(Box, { marginTop: 1 }, footer)));
};
/**
 * One card per run. The task and outcome are content that must not be clipped, so
 * they are the first line of the body; the border title only names the kind of card.
 */
export const CardsSubagentFeed = ({ title, statusSuffix, tone, summary, children }) => {
    const theme = useTheme();
    return (React.createElement(Card, { color: theme[tone], shape: tone === 'danger' ? 'bold' : 'round', title: React.createElement(Text, { color: theme[tone], bold: true }, "subagent") },
        React.createElement(Text, { color: theme[tone] },
            title,
            statusSuffix),
        summary !== undefined ? React.createElement(Text, { color: theme.textSubtle }, summary) : children));
};
/** Content panels and callouts are cards; row runs are indented, so a list of matches does not become a stack of boxes. */
export const CardsToolSection = ({ variant, title, tone = 'warning', children }) => {
    const theme = useTheme();
    if (variant === 'indent') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: 2 }, children));
    }
    if (variant === 'panel') {
        return React.createElement(Card, { color: theme.textSubtle }, children);
    }
    return (React.createElement(Card, { color: theme[tone], title: title === undefined ? undefined : (React.createElement(Text, { color: theme[tone], bold: true, wrap: "truncate-end" }, title)) }, children));
};
/** The same card as everything else, titled with the menu's name; hints sit under it. */
export const CardsMenuFrame = ({ title, borderColor, footer, footerPlacement, children }) => {
    const theme = useTheme();
    const color = borderColor ?? theme.borderActive;
    const footerNode = footer ? (typeof footer === 'string' ? (React.createElement(Text, { color: theme.textSubtle }, footer)) : (footer)) : null;
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(Card, { color: color, title: title ? (React.createElement(Text, { color: theme.textMuted, bold: true, wrap: "truncate-end" }, title)) : undefined },
            children,
            footerPlacement === 'inside' && footerNode && React.createElement(Box, { marginTop: 1 }, footerNode)),
        footerPlacement === 'outside' && footerNode));
};
//# sourceMappingURL=body.js.map