import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
export function getCodePreview(text, maxLength = 60) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        return '';
    if (cleaned.length <= maxLength)
        return cleaned;
    return `${cleaned.slice(0, maxLength - 1)}…`;
}
const CopyMenu = ({ items, selectedIndex }) => {
    const theme = useTheme();
    return (React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, borderColor: theme.accent, footer: React.createElement(MenuFooter, { hints: [
                ['↑↓', 'navigate'],
                ['⏎', 'copy'],
                ['Esc', 'cancel'],
            ] }), renderItem: (item, index, isSelected) => {
            const isCodeBlock = item.label !== 'Full response';
            const preview = isCodeBlock ? getCodePreview(item.text) : '';
            return (React.createElement(Box, { key: `${item.label}-${index}` },
                React.createElement(SelectionMarker, { selected: isSelected }),
                React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected }, `${index + 1}. ${item.label}`),
                preview ? (React.createElement(Text, { color: isSelected ? theme.accent : theme.textSubtle, dimColor: !isSelected }, ` — ${preview}`)) : null));
        } }));
};
export default CopyMenu;
//# sourceMappingURL=CopyMenu.js.map