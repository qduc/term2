import React from 'react';
import { Box, Text } from 'ink';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const ProfileSelectionMenu = ({ items, activeProfileId, selectedIndex, scrollOffset = 0, query }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    if (items.length === 0) {
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(MenuFrame, { title: "Profiles", borderColor: theme.borderActive, hasItems: false, footer: React.createElement(MenuFooter, { hints: [['Esc', 'cancel']] }), footerPlacement: "outside" },
                React.createElement(Text, { color: theme.textSubtle }, "No matching profiles"))));
    }
    const maxHeight = 10;
    const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
    const hasScrollUp = scrollOffset > 0;
    const hasScrollDown = scrollOffset + maxHeight < items.length;
    const selectedProfile = items[selectedIndex];
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(MenuFrame, { title: `Profiles${query ? ` — ${query}` : ''}`, borderColor: theme.borderActive, hasItems: true, footer: React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'switch'],
                    ['Esc', 'cancel'],
                ] }), footerPlacement: "outside" },
            React.createElement(Box, { flexDirection: "row", width: "100%" },
                React.createElement(Box, { flexDirection: "column", width: "50%", borderStyle: "single", borderTop: false, borderBottom: false, borderLeft: false, borderRight: true, borderColor: theme.border, paddingRight: 1 },
                    React.createElement(Box, { flexDirection: "row", width: "100%" },
                        React.createElement(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 }, visibleItems.map((profile, visibleIndex) => {
                            const actualIndex = scrollOffset + visibleIndex;
                            const isSelected = actualIndex === selectedIndex;
                            const isActive = profile.id === activeProfileId;
                            const label = isActive ? `● ${profile.displayName}` : profile.displayName;
                            return (React.createElement(Box, { key: profile.id },
                                React.createElement(SelectionMarker, { selected: isSelected }),
                                React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected || isActive, wrap: "truncate" }, label)));
                        })),
                        hasScrollUp || hasScrollDown ? (React.createElement(MenuScrollbar, { itemCount: items.length, scrollOffset: scrollOffset, maxHeight: maxHeight })) : null)),
                React.createElement(Box, { flexDirection: "column", width: "50%", paddingLeft: 2 }, selectedProfile && (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(Text, { bold: true, color: theme.accent }, selectedProfile.displayName),
                    React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.text }, selectedProfile.detail)),
                    React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.textSubtle }, selectedProfile.id === activeProfileId
                            ? 'Currently active'
                            : `Run /profile ${selectedProfile.shortId} to switch`)))))))));
};
export default ProfileSelectionMenu;
//# sourceMappingURL=ProfileSelectionMenu.js.map