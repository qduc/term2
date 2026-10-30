import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { Card } from './card.js';
/** `❯ command` on a quiet surface, like the input it echoes. */
export const CardsShellActivity = ({ command }) => {
    const theme = useTheme();
    return (React.createElement(Box, null,
        React.createElement(Box, { flexShrink: 0, marginRight: 1 },
            React.createElement(Text, { color: theme.danger, bold: true }, "!")),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.textSubtle },
                "running ",
                React.createElement(Text, { bold: true }, command)))));
};
/** Border and padding either side of a card. */
export const CARDS_TASK_PANEL_GUTTER = 4;
export const CardsTaskPanel = ({ header, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { marginBottom: 1, flexDirection: "column" },
        React.createElement(Card, { color: theme.accentAlt, title: React.createElement(Text, { color: theme.accentAlt, bold: true }, header) }, children)));
};
//# sourceMappingURL=activity.js.map