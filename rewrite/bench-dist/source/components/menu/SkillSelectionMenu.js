import React from 'react';
import { Box, Text } from 'ink';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const SkillSelectionMenu = ({ items, selectedIndex, scrollOffset = 0, query }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    if (items.length === 0) {
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(MenuFrame, { title: "Skills", borderColor: theme.borderActive, hasItems: false, footer: React.createElement(MenuFooter, { hints: [['Esc', 'cancel']] }), footerPlacement: "outside" },
                React.createElement(Text, { color: theme.textSubtle }, query ? 'No matching skills' : 'No skills available'))));
    }
    const maxHeight = 10;
    const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
    const hasScrollUp = scrollOffset > 0;
    const hasScrollDown = scrollOffset + maxHeight < items.length;
    const selectedSkill = items[selectedIndex];
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(MenuFrame, { title: "Skills", borderColor: theme.borderActive, hasItems: true, footer: React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'select'],
                    ['Esc', 'cancel'],
                ] }), footerPlacement: "outside" },
            React.createElement(Box, { flexDirection: "row", width: "100%" },
                React.createElement(Box, { flexDirection: "column", width: "50%", borderStyle: "single", borderTop: false, borderBottom: false, borderLeft: false, borderRight: true, borderColor: theme.border, paddingRight: 1 },
                    React.createElement(Box, { flexDirection: "row", width: "100%" },
                        React.createElement(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 }, visibleItems.map((skill, visibleIndex) => {
                            const actualIndex = scrollOffset + visibleIndex;
                            const isSelected = actualIndex === selectedIndex;
                            return (React.createElement(Box, { key: skill.name },
                                React.createElement(SelectionMarker, { selected: isSelected }),
                                React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected, wrap: "truncate" }, skill.name)));
                        })),
                        hasScrollUp || hasScrollDown ? (React.createElement(MenuScrollbar, { itemCount: items.length, scrollOffset: scrollOffset, maxHeight: maxHeight })) : null)),
                React.createElement(Box, { flexDirection: "column", width: "50%", paddingLeft: 2 }, selectedSkill && (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(Text, { bold: true, color: theme.accent }, selectedSkill.name),
                    React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.text }, selectedSkill.description)),
                    React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.textSubtle },
                            "Scope: ",
                            selectedSkill.isProjectLevel ? 'Project level' : 'Global')))))))));
};
export default SkillSelectionMenu;
//# sourceMappingURL=SkillSelectionMenu.js.map