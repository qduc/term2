import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { computeVisibleTabs } from './compute-visible-tabs.js';
import { useTheme } from '../theme.js';
/**
 * A generic scrollable tab bar component that renders visible tabs based on
 * available terminal width, with scroll arrows and optional hint text.
 *
 * Uses a greedy algorithm starting from the active tab to fit as many tabs
 * as possible within the available width.
 */
export function ScrollableTabBar({ items, activeItemId, getItemWidth, renderTab, hint, }) {
    const theme = useTheme();
    const { stdout } = useStdout();
    const terminalWidth = stdout?.columns || process.stdout.columns || 80;
    const hintLength = hint ? hint.length : 0;
    const availableWidth = terminalWidth - hintLength - 2; // -2 for padding
    const { visibleItems, hasLeftScroll, hasRightScroll } = computeVisibleTabs(items, activeItemId, availableWidth, getItemWidth);
    return (React.createElement(Box, { justifyContent: "space-between" },
        React.createElement(Box, null,
            hasLeftScroll && React.createElement(Text, { color: theme.textSubtle }, "\u25C0 "),
            visibleItems.map((item, index) => (React.createElement(Box, { key: item.id },
                renderTab(item, item.id === activeItemId),
                index < visibleItems.length - 1 && React.createElement(Text, { color: theme.textSubtle }, ' │ ')))),
            hasRightScroll && React.createElement(Text, { color: theme.textSubtle }, " \u25B6")),
        hint && React.createElement(Text, { color: theme.textSubtle }, hint)));
}
//# sourceMappingURL=ScrollableTabBar.js.map