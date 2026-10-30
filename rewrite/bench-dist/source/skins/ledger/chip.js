import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../../components/theme.js';
export const Chip = ({ tone = 'textMuted', bold, solid, surface, surfaceText, children }) => {
    const theme = useTheme();
    const color = theme[tone];
    if (solid) {
        return (React.createElement(Text, { inverse: true, bold: true, color: color },
            ' ',
            children,
            ' '));
    }
    const background = surface ?? theme.codeBackground;
    if (background === undefined) {
        return (React.createElement(Text, { color: color, bold: bold },
            "[",
            children,
            "]"));
    }
    return (React.createElement(Text, { backgroundColor: background, color: surfaceText ?? color, bold: bold },
        ' ',
        children,
        ' '));
};
//# sourceMappingURL=chip.js.map