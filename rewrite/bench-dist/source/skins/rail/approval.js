import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SELECTED, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { RAIL_HEAVY, RAIL_SOLID, Rail } from './parts.js';
/**
 * A rail down the whole height of the request, in place of a box. The two classes
 * differ in shape as well as colour, so they are told apart in `mono` and by a
 * glance: caution is a half-block rail under a plain title; danger is a solid
 * block rail under a title that begins with `▲`.
 */
export const RailApprovalFrame = ({ tone, header, subheader, children }) => {
    const theme = useTheme();
    const danger = tone === 'danger';
    return (React.createElement(Rail, { glyph: danger ? RAIL_SOLID : RAIL_HEAVY, color: danger ? theme.danger : theme.warning },
        React.createElement(Text, { bold: true, color: danger ? theme.danger : undefined },
            danger ? `${GLYPH_WARNING} ` : '',
            header),
        subheader,
        children));
};
/**
 * The question, then a numbered list with the selected row in its tone, then the
 * selected option's description as one dim line, in place of a side pane. The
 * list-only layout (no description to show) is the same list without the line.
 */
export const RailApprovalChoices = ({ question, options, selectedIndex, layout, description, }) => {
    const theme = useTheme();
    const note = layout === 'two-pane' ? description?.text : undefined;
    return (React.createElement(Box, { flexDirection: "column" },
        layout === 'two-pane' && question !== undefined && React.createElement(Text, { bold: true }, question),
        options.map((option, index) => {
            const selected = index === selectedIndex;
            const tone = theme[option.tone];
            return (React.createElement(Box, { key: option.label },
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: theme.accent, bold: true }, selected ? GLYPH_SELECTED : ' ')),
                React.createElement(Box, { width: 2, flexShrink: 0 },
                    React.createElement(Text, { color: selected ? tone : theme.textSubtle, bold: selected }, index + 1)),
                React.createElement(Box, { flexShrink: 1 },
                    React.createElement(Text, { color: selected ? tone : theme.textMuted, bold: selected }, option.label))));
        }),
        note && (React.createElement(Box, { marginLeft: 4 },
            React.createElement(Text, { color: theme.textSubtle, italic: true }, note)))));
};
//# sourceMappingURL=approval.js.map