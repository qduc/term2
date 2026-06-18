import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SkillInfo } from '../../services/skills/skills-service.js';

type Props = {
  items: SkillInfo[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const SkillSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query }) => {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor="#22d3ee" paddingX={1}>
        <Text color="gray">{query ? 'No matching skills' : 'No skills available'}</Text>
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const longestNameLength = Math.max(...items.map((item) => item.name.length), 10);
  const leftColWidth = Math.min(longestNameLength + 4, 30);

  const selectedSkill = items[selectedIndex];

  return (
    <Box borderStyle="round" borderColor="#22d3ee" flexDirection="row" width="100%">
      {/* Left Column: Skill List */}
      <Box
        flexDirection="column"
        width={leftColWidth}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderRight={true}
        borderColor="#334155"
        paddingRight={1}
      >
        {hasScrollUp && <Text color="#64748b">↑ more</Text>}
        {visibleItems.map((skill, visibleIndex) => {
          const actualIndex = scrollOffset + visibleIndex;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Box key={skill.name}>
              <Text color={isSelected ? '#22d3ee' : undefined} bold={isSelected} inverse={isSelected} wrap="truncate">
                {' '}
                {skill.name}{' '}
              </Text>
            </Box>
          );
        })}
        {hasScrollDown && <Text color="#64748b">↓ more</Text>}
      </Box>

      {/* Right Column: Detail Panel */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {selectedSkill && (
          <Box flexDirection="column">
            <Text bold color="#22d3ee">
              {selectedSkill.name.toUpperCase()}
            </Text>
            <Box marginTop={1}>
              <Text color="white">{selectedSkill.description}</Text>
            </Box>
            <Box flexDirection="column" marginTop={1}>
              <Text color="#64748b">Scope: {selectedSkill.isProjectLevel ? 'Project level' : 'Global'}</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default SkillSelectionMenu;
