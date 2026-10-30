import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
/**
 * `indent` sits two columns in, `panel` is a single-line box, `callout` a rounded
 * box with a bold heading. Spacing between sections stays with the renderer.
 */
export const ClassicToolSection = ({ variant, title, tone = 'warning', children }) => {
    const theme = useTheme();
    if (variant === 'indent') {
        return (React.createElement(Box, { flexDirection: "column", paddingLeft: 2 }, children));
    }
    if (variant === 'panel') {
        return (React.createElement(Box, { flexDirection: "column", borderStyle: "single", borderColor: theme.textSubtle, paddingX: 1 }, children));
    }
    return (React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme[tone], paddingX: 1 },
        title !== undefined && (React.createElement(Text, { color: theme[tone], bold: true }, title)),
        children));
};
//# sourceMappingURL=tool-section.js.map