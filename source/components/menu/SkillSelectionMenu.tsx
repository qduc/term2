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

  const selectedSkill = items[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Skills</Text>
        {/* The two columns split the row evenly at every terminal width: each
            takes half, so the divider sits in the middle instead of tracking
            the longest name. Both columns have a definite width, which lets
            Yoga hand each `wrap="truncate"` label a finite budget — the label
            is clipped to its own column and never spills past the divider or
            the border. */}
        <Box flexDirection="row" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width="50%"
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
          <Box flexDirection="column" width="50%" paddingLeft={2}>
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
