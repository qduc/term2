import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
const PathSelectionMenu = ({ items, selectedIndex, query, loading = false, error = null, warning = null, scrollOffset = 0, maxHeight = 10, }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        warning && React.createElement(Text, { color: theme.warning }, warning),
        React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, scrollOffset: scrollOffset, maxHeight: maxHeight, borderColor: theme.accent, loading: loading, loadingText: "Loading project paths\u2026", error: error ? `Unable to load paths: ${error}` : null, fallbackText: `No matches for "@${query}"`, footer: React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'insert'],
                    ['Tab', 'insert w/o space'],
                    ['Esc', 'cancel'],
                ] }), footerOutsideBorder: true, renderItem: (item, _index, isSelected) => {
                const label = item.type === 'directory' && !item.path.endsWith('/') ? `${item.path}/` : item.path;
                return (React.createElement(Box, { key: item.path },
                    React.createElement(SelectionMarker, { selected: isSelected }),
                    React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected }, label)));
            } })));
};
export default PathSelectionMenu;
//# sourceMappingURL=PathSelectionMenu.js.map