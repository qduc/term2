import React from 'react';
import { Box, Text } from 'ink';
const TOP_CORNERS = {
    round: { left: '╭', right: '╮', rule: '─' },
    double: { left: '╔', right: '╗', rule: '═' },
    bold: { left: '┏', right: '┓', rule: '━' },
};
/** More rule glyphs than any terminal is wide; the rule box clips them to the room actually left. */
const RULE_OVERSHOOT = 400;
/**
 * A bordered box with one column of padding either side, so text inside starts
 * three columns in. The top rule is a flexible box rather than a fixed string,
 * which is what keeps the right corner on the right edge at every width.
 */
export const Card = ({ color, shape = 'round', title, fit = false, children }) => {
    const body = (React.createElement(Box, { flexDirection: "column", borderStyle: shape, borderColor: color, borderTop: title === undefined, paddingX: 1, flexGrow: fit ? 0 : 1 }, children));
    if (title === undefined) {
        return (React.createElement(Box, { flexDirection: "column", alignSelf: fit ? 'flex-start' : undefined }, body));
    }
    const corners = TOP_CORNERS[shape];
    return (React.createElement(Box, { flexDirection: "column", alignSelf: fit ? 'flex-start' : undefined },
        React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0 },
                React.createElement(Text, { color: color },
                    corners.left,
                    corners.rule,
                    ' ')),
            React.createElement(Box, { flexShrink: 1 }, title),
            React.createElement(Box, { flexShrink: 0 },
                React.createElement(Text, { color: color }, " ")),
            React.createElement(Box, { flexGrow: 1, flexBasis: 0, minWidth: 1, height: 1, overflow: "hidden" },
                React.createElement(Text, { color: color, wrap: "wrap" }, corners.rule.repeat(RULE_OVERSHOOT))),
            React.createElement(Box, { flexShrink: 0 },
                React.createElement(Text, { color: color }, corners.right))),
        body));
};
//# sourceMappingURL=card.js.map