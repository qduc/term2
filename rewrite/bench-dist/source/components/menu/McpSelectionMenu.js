import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
export function McpSelectionMenu({ title, items, selectedIndex, error, editing, }) {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: theme.accent, bold: true, underline: true }, title),
        error ? (React.createElement(Text, { color: theme.danger },
            GLYPH_WARNING,
            " ",
            error)) : null,
        editing ? React.createElement(Text, { color: theme.textSubtle }, "Enter a value below. Esc cancels.") : null,
        !editing ? (React.createElement(MenuContainer, { items: [...items], selectedIndex: selectedIndex, borderColor: error ? theme.danger : theme.accent, footer: React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'select'],
                    ['Esc', 'back'],
                ] }), renderItem: (item, index, selected) => (React.createElement(Box, { key: item.id },
                React.createElement(SelectionMarker, { selected: selected }),
                React.createElement(Text, { bold: selected, color: item.tone === 'danger' ? theme.danger : item.tone === 'warning' ? theme.warning : theme.text }, item.label),
                item.detail ? React.createElement(Text, { color: theme.textSubtle },
                    " ",
                    item.detail) : null)) })) : null));
}
//# sourceMappingURL=McpSelectionMenu.js.map