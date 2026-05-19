import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { UndoItem } from '../hooks/use-undo-selection.js';

type Props = {
  items: UndoItem[];
  selectedIndex: number;
  scrollOffset?: number;
  maxHeight?: number;
};

export const MAX_VISIBLE_ITEMS = 10;
const TRUNCATE_LENGTH = 60;

const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
};

const UndoSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, maxHeight = MAX_VISIBLE_ITEMS }) => {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">No messages to undo</Text>
      </Box>
    );
  }

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text color="yellow" bold>
            Undo to message
          </Text>
          {items.length > maxHeight && (
            <Text color="#64748b">
              {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, items.length)}/{items.length}
            </Text>
          )}
        </Box>
        {hasScrollUp && <Text color="#64748b">↑ {scrollOffset} more</Text>}
        {visibleItems.map((item, visibleIndex) => {
          const actualIndex = scrollOffset + visibleIndex;
          const isSelected = actualIndex === selectedIndex;
          const label = `${String(item.uiIndex + 1).padStart(2)}. ${truncate(item.text, TRUNCATE_LENGTH - 4)}`;
          return (
            <Box key={item.uiIndex}>
              <Text inverse={isSelected} color={isSelected ? 'yellow' : undefined} bold={isSelected}>
                {label}
              </Text>
            </Box>
          );
        })}
        {hasScrollDown && <Text color="#64748b">↓ {items.length - scrollOffset - maxHeight} more</Text>}
      </Box>
      <Text color="#64748b">Enter → undo here · Esc → cancel · ↑↓ → navigate</Text>
    </Box>
  );
};

export default UndoSelectionMenu;
