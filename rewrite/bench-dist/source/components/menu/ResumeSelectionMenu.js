import React from 'react';
import { Box, Text } from 'ink';
import { profileIdFromLegacyMode } from '../../services/profiles/legacy-adapter.js';
import { getProfileLabel } from '../../services/profiles/labels.js';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
function formatDate(dateString) {
    try {
        const d = new Date(dateString);
        if (!isNaN(d.getTime())) {
            const pad = (n) => n.toString().padStart(2, '0');
            const year = d.getFullYear();
            const month = pad(d.getMonth() + 1);
            const date = pad(d.getDate());
            const hours = pad(d.getHours());
            const minutes = pad(d.getMinutes());
            const seconds = pad(d.getSeconds());
            return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
        }
    }
    catch {
        // fallback
    }
    return dateString;
}
function formatRelativeTime(dateString) {
    const timestamp = Date.parse(dateString);
    if (!Number.isFinite(timestamp))
        return dateString;
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const units = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['week', 604_800],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
        ['second', 1],
    ];
    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    for (const [unit, size] of units)
        if (Math.abs(seconds) >= size)
            return formatter.format(Math.round(seconds / size), unit);
    return formatter.format(0, 'second');
}
function getActiveMode(activeProfileId, appMode) {
    return getProfileLabel(activeProfileId ?? profileIdFromLegacyMode(appMode));
}
const ResumeSelectionMenu = ({ items, selectedIndex, scrollOffset = 0, query, loading, error }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    if (loading || error || items.length === 0) {
        return (React.createElement(MenuFrame, { title: "Resume Conversation", borderColor: theme.borderActive, hasItems: false, footer: React.createElement(MenuFooter, { hints: [['Esc', 'cancel']] }), footerPlacement: "outside" },
            React.createElement(Text, { color: error ? theme.danger : theme.textSubtle }, loading
                ? 'Loading conversations...'
                : error
                    ? `Could not load conversations: ${error}`
                    : query
                        ? 'No matching conversations'
                        : 'No saved conversations found')));
    }
    const maxHeight = 10;
    const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
    const hasScrollUp = scrollOffset > 0;
    const hasScrollDown = scrollOffset + maxHeight < items.length;
    const selectedEntry = items[selectedIndex];
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(MenuFrame, { title: "Resume Conversation", borderColor: theme.borderActive, hasItems: true, footer: React.createElement(MenuFooter, { hints: [
                    ['↑↓', 'navigate'],
                    ['⏎', 'resume'],
                    ['Esc', 'cancel'],
                ] }), footerPlacement: "outside" },
            React.createElement(Box, { flexDirection: "row", width: "100%" },
                React.createElement(Box, { flexDirection: "column", width: "50%", borderStyle: "single", borderTop: false, borderBottom: false, borderLeft: false, borderRight: true, borderColor: theme.border, paddingRight: 1 },
                    React.createElement(Box, { flexDirection: "row", width: "100%" },
                        React.createElement(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 }, visibleItems.map((entry, visibleIndex) => {
                            const actualIndex = scrollOffset + visibleIndex;
                            const isSelected = actualIndex === selectedIndex;
                            return (React.createElement(Box, { key: entry.id },
                                React.createElement(SelectionMarker, { selected: isSelected }),
                                React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected, wrap: "truncate" },
                                    entry.firstUserMessage?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled conversation',
                                    ' · ',
                                    formatRelativeTime(entry.updatedAt),
                                    entry.messageCount !== undefined
                                        ? ` · ${entry.messageCount} msg${entry.messageCount === 1 ? '' : 's'}`
                                        : '')));
                        })),
                        hasScrollUp || hasScrollDown ? (React.createElement(MenuScrollbar, { itemCount: items.length, scrollOffset: scrollOffset, maxHeight: maxHeight })) : null)),
                React.createElement(Box, { flexDirection: "column", width: "50%", paddingLeft: 2 }, selectedEntry && (React.createElement(Box, { flexDirection: "column" },
                    React.createElement(Text, { bold: true, color: theme.accent }, selectedEntry.id),
                    React.createElement(Box, { marginTop: 0 },
                        React.createElement(Text, { color: theme.textSubtle },
                            "Updated: ",
                            React.createElement(Text, { color: theme.text }, formatDate(selectedEntry.updatedAt)))),
                    React.createElement(Box, { marginTop: 0 },
                        React.createElement(Text, { color: theme.textSubtle },
                            selectedEntry.sshHost ? `SSH (${selectedEntry.sshHost})` : 'Local',
                            selectedEntry.messageCount !== undefined &&
                                ` • ${selectedEntry.messageCount} msg${selectedEntry.messageCount === 1 ? '' : 's'}`,
                            selectedEntry.model && ` • ${selectedEntry.model}`,
                            getActiveMode(selectedEntry.activeProfileId, selectedEntry.appMode) !== 'standard' &&
                                ` • mode: ${getActiveMode(selectedEntry.activeProfileId, selectedEntry.appMode)}`)),
                    selectedEntry.firstUserMessage && (React.createElement(Box, { marginTop: 1, flexDirection: "column" },
                        React.createElement(Text, { color: theme.textSubtle }, "Initial Prompt:"),
                        React.createElement(Text, { color: theme.text, italic: true, wrap: "truncate" },
                            "\"",
                            selectedEntry.firstUserMessage.slice(0, 150).replace(/\n/g, ' '),
                            "\""))))))))));
};
export default ResumeSelectionMenu;
//# sourceMappingURL=ResumeSelectionMenu.js.map