import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
/** `◆ running command`, as quiet as the working indicator it replaces. */
export const ZenShellActivity = ({ command }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    return (React.createElement(Box, { paddingLeft: MARKER_COLUMNS },
        React.createElement(Text, { ...faint },
            React.createElement(Text, { color: theme.accent }, "\u25C6"),
            " running ",
            React.createElement(Text, { bold: true }, command))));
};
export const ZEN_TASK_PANEL_GUTTER = MARKER_COLUMNS;
export const ZenTaskPanel = ({ header, children }) => {
    const { faint } = useZenStyles();
    return (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS, marginBottom: 1 },
        React.createElement(Text, { ...faint }, header),
        children));
};
//# sourceMappingURL=activity.js.map