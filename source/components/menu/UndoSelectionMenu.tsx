import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { UndoItem } from '../../hooks/use-undo-selection.js';
import { MenuContainer } from '../common/MenuContainer.js';

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
  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={maxHeight}
      borderColor="yellow"
      fallbackText={<Text color="yellow">No messages to undo</Text>}
      footer="Enter → undo here · Esc → cancel · ↑↓ → navigate"
      footerOutsideBorder={true}
      renderItem={(item, _index, isSelected) => {
        const label = `${String(item.uiIndex + 1).padStart(2)}. ${truncate(item.text, TRUNCATE_LENGTH - 4)}`;
        return (
          <Box key={item.uiIndex}>
            <Text inverse={isSelected} color={isSelected ? 'yellow' : undefined} bold={isSelected}>
              {label}
            </Text>
          </Box>
        );
      }}
    />
  );
};

export default UndoSelectionMenu;
