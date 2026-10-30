import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { RAIL_THIN, Rail } from './parts.js';
/** `$ command`: the shell marker the prompt uses, then the command, quiet. */
export const RailShellActivity = ({ command }) => {
    const theme = useTheme();
    return (React.createElement(Box, null,
        React.createElement(Box, { width: 2, flexShrink: 0 },
            React.createElement(Text, { color: theme.danger, bold: true }, "$")),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.textMuted }, command))));
};
/** The tasks sit behind a thin rail, which costs two columns. */
export const RAIL_TASK_PANEL_GUTTER = 2;
export const RailTaskPanel = ({ header, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { marginBottom: 1 },
        React.createElement(Rail, { glyph: RAIL_THIN, color: theme.accentAlt },
            React.createElement(Text, { color: theme.textMuted, bold: true }, header),
            children)));
};
//# sourceMappingURL=activity.js.map