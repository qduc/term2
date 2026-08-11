import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { CopySelection } from '../../utils/copy-selections.js';
import { MenuContainer } from '../common/MenuContainer.js';

type Props = {
  items: CopySelection[];
  selectedIndex: number;
};

const CopyMenu: FC<Props> = ({ items, selectedIndex }) => (
  <MenuContainer
    items={items}
    selectedIndex={selectedIndex}
    borderColor="cyan"
    footer="⏎ copy · esc cancel · ↑↓ navigate"
    renderItem={(item, index, isSelected) => (
      <Box key={`${item.label}-${index}`}>
        <Text inverse={isSelected} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
          {`${isSelected ? '▸' : ' '} ${index + 1}. ${item.label}`}
        </Text>
      </Box>
    )}
  />
);

export default CopyMenu;
