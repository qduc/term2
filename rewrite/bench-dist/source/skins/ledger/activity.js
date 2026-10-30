import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { Chip } from './chip.js';
/** A `SHELL` chip, then the command. */
export const LedgerShellActivity = ({ command }) => {
    const theme = useTheme();
    return (React.createElement(Box, null,
        React.createElement(Box, { flexShrink: 0, marginRight: 1 },
            React.createElement(Chip, { tone: "danger", bold: true }, "SHELL")),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.text, bold: true }, command))));
};
export const LedgerTaskPanel = ({ header, children }) => (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
    React.createElement(Box, { alignSelf: "flex-start" },
        React.createElement(Chip, { tone: "accentAlt", bold: true }, header)),
    children));
//# sourceMappingURL=activity.js.map