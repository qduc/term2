import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { computeVisibleTabs } from './compute-visible-tabs.js';

export interface ScrollableTabBarProps<T extends { id: string }> {
  /** Array of tab items (must have an `id` property) */
  items: T[];
  /** ID of the currently active tab */
  activeItemId: string;
  /** Function to compute the display width of each tab item */
  getItemWidth: (item: T) => number;
  /** Callback to render a tab; receives item and isActive boolean */
  renderTab: (item: T, isActive: boolean) => React.ReactNode;
  /** Optional hint text shown on the right side of the tab bar */
  hint?: string;
}

/**
 * A generic scrollable tab bar component that renders visible tabs based on
 * available terminal width, with scroll arrows and optional hint text.
 *
 * Uses a greedy algorithm starting from the active tab to fit as many tabs
 * as possible within the available width.
 */
export function ScrollableTabBar<T extends { id: string }>({
  items,
  activeItemId,
  getItemWidth,
  renderTab,
  hint,
}: ScrollableTabBarProps<T>): React.ReactElement {
  const { stdout } = useStdout();
  const terminalWidth = (stdout as any)?.columns || process.stdout.columns || 80;
  const hintLength = hint ? hint.length : 0;
  const availableWidth = terminalWidth - hintLength - 2; // -2 for padding

  const { visibleItems, hasLeftScroll, hasRightScroll } = computeVisibleTabs(
    items,
    activeItemId,
    availableWidth,
    getItemWidth,
  );

  return (
    <Box justifyContent="space-between">
      <Box>
        {hasLeftScroll && <Text color="#64748b">◀ </Text>}
        {visibleItems.map((item, index) => (
          <Box key={item.id}>
            {renderTab(item, item.id === activeItemId)}
            {index < visibleItems.length - 1 && <Text color="#64748b">{' │ '}</Text>}
          </Box>
        ))}
        {hasRightScroll && <Text color="#64748b"> ▶</Text>}
      </Box>
      {hint && <Text color="#64748b">{hint}</Text>}
    </Box>
  );
}
