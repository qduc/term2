import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
/** A rounded box; hints go under a hairline inside it, or below it. */
export const ClassicMenuFrame = ({ title, borderColor, hasItems, footer, footerPlacement, children, }) => {
    const theme = useTheme();
    const color = borderColor ?? theme.borderActive;
    const footerNode = footer ? (typeof footer === 'string' ? (React.createElement(Text, { color: theme.textSubtle }, footer)) : (footer)) : null;
    const body = (React.createElement(Box, { borderStyle: "round", borderColor: color, paddingX: 1, flexDirection: "column", width: hasItems ? '100%' : undefined },
        title ? React.createElement(Text, { color: theme.textSubtle }, title) : null,
        children,
        footerPlacement === 'inside' && footerNode && (React.createElement(Box, { marginTop: 1, borderStyle: "single", borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, borderColor: theme.border }, footerNode))));
    if (footerPlacement === 'outside' && footerNode) {
        return (React.createElement(Box, { flexDirection: "column", width: "100%" },
            body,
            footerNode));
    }
    return body;
};
//# sourceMappingURL=menu.js.map