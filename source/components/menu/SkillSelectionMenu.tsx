import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import { MenuContainer } from '../common/MenuContainer.js';

type Props = {
  items: SkillInfo[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const SkillSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0 }) => {
  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      borderColor="#22d3ee"
      fallbackText={items.length === 0 ? 'No skills available' : 'No matching skills'}
      renderItem={(skill, _index, isSelected) => (
        <Box key={skill.name}>
          <Text color={isSelected ? '#22d3ee' : undefined} bold={isSelected} inverse={isSelected}>
            {' '}
            {skill.name}{' '}
          </Text>
          <Text color="#64748b"> - {skill.description}</Text>
        </Box>
      )}
    />
  );
};

export default SkillSelectionMenu;
