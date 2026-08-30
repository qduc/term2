import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import { SelectionMarker, MenuFooter } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_BORDER, COLOR_BORDER_ACTIVE, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  items: SkillInfo[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const SkillSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query }) => {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1} flexDirection="column">
        <Text color={COLOR_TEXT_SUBTLE}>Skills</Text>
        <Text color={COLOR_TEXT_SUBTLE}>{query ? 'No matching skills' : 'No skills available'}</Text>
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const longestNameLength = Math.max(...items.map((item) => item.name.length), 10);
  // +4 covers the two-cell selection gutter plus breathing room.
  const leftColWidth = Math.min(longestNameLength + 4, 30);

  const selectedSkill = items[selectedIndex];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Skills</Text>
        <Box flexDirection="row" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width={leftColWidth}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
            borderColor={COLOR_BORDER}
            paddingRight={1}
          >
            {hasScrollUp && <Text color={COLOR_TEXT_SUBTLE}>↑ more</Text>}
            {visibleItems.map((skill, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              return (
                <Box key={skill.name}>
                  <SelectionMarker selected={isSelected} />
                  <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected} wrap="truncate">
                    {skill.name}
                  </Text>
                </Box>
              );
            })}
            {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ more</Text>}
          </Box>

          {/* Right column: detail for the highlighted skill */}
          <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
            {selectedSkill && (
              <Box flexDirection="column">
                <Text bold color={COLOR_ACCENT}>
                  {selectedSkill.name}
                </Text>
                <Box marginTop={1}>
                  <Text color={COLOR_TEXT}>{selectedSkill.description}</Text>
                </Box>
                <Box marginTop={1}>
                  <Text color={COLOR_TEXT_SUBTLE}>
                    Scope: {selectedSkill.isProjectLevel ? 'Project level' : 'Global'}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <MenuFooter
        hints={[
          ['↑↓', 'navigate'],
          ['⏎', 'select'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
};

export default SkillSelectionMenu;
