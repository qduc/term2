import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { SLASH_MENU_BINDINGS, bindingHints } from '../input/menu-bindings.js';
/**
 * Width of the `/name` label column, sized to the longest command so short
 * names leave room for the description instead of padding it out, and capped
 * so one long name cannot eat the row. Computed from the full list (not the
 * filter) so the column does not jitter while typing. The label text
 * truncates rather than wrapping: the description carries the meaning.
 */
export const SLASH_COMMAND_LABEL_MAX_WIDTH = 20;
const SEPARATOR_COLUMN_WIDTH = 3;
const SlashCommandMenu = ({ commands, selectedIndex, filter, scrollOffset = 0 }) => {
    const theme = useTheme();
    const filteredCommands = commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase()));
    const labelColumnWidth = Math.min(Math.max(...commands.map((cmd) => cmd.name.length + 1), 8), SLASH_COMMAND_LABEL_MAX_WIDTH);
    return (React.createElement(MenuContainer, { items: filteredCommands, selectedIndex: selectedIndex, scrollOffset: scrollOffset, title: "Commands", fallbackText: "No matching commands", footer: React.createElement(MenuFooter, { hints: bindingHints(SLASH_MENU_BINDINGS) }), renderItem: (cmd, _index, isSelected) => (React.createElement(Box, { key: cmd.name, width: "100%", flexDirection: "row", flexWrap: "wrap" },
            React.createElement(SelectionMarker, { selected: isSelected }),
            React.createElement(Box, { width: labelColumnWidth, flexShrink: 0 },
                React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected, wrap: "truncate" },
                    "/",
                    cmd.name)),
            React.createElement(Box, { width: SEPARATOR_COLUMN_WIDTH, flexShrink: 0 },
                React.createElement(Text, { color: theme.textSubtle, wrap: "truncate" },
                    ' ',
                    "-")),
            React.createElement(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: "50%" },
                React.createElement(Text, { color: isSelected ? theme.text : theme.textSubtle }, cmd.description)))) }));
};
export default SlashCommandMenu;
//# sourceMappingURL=SlashCommandMenu.js.map