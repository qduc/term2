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
  // Width of the SelectionMarker gutter. List labels are truncated to the
  // column budget minus this gutter and the column's trailing padding.
  const MARKER_WIDTH = 2;

  const selectedSkill = items[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Skills</Text>
        {/* flexWrap + minWidth is the narrow-terminal plan: while the detail
            pane has at least half the row it sits beside the list with a
            straight divider; below that it drops to its own full-width line
            instead of squeezing the list gutter or fragmenting the text.
            The list column only shrinks when it alone overflows the row
            (never because of the description), down to a floor that keeps
            the marker plus a readable stub of the name. */}
        <Box flexDirection="row" flexWrap="wrap" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width={leftColWidth}
            flexShrink={1}
            minWidth={10}
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
              // Truncate to the column's own budget in JS: an unbreakable
              // (truncate-mode) Text reports its full length as its minimum
              // width, which would defeat the column's shrinking on narrow
              // terminals and spill past the border. The full name stays
              // visible in the detail pane.
              const nameBudget = Math.max(leftColWidth - MARKER_WIDTH - 1, 4);
              const displayName =
                skill.name.length > nameBudget ? `${skill.name.slice(0, Math.max(nameBudget - 1, 1))}…` : skill.name;
              return (
                <Box key={skill.name}>
                  <SelectionMarker selected={isSelected} />
                  <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected} wrap="truncate">
                    {displayName}
                  </Text>
                </Box>
              );
            })}
            {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ more</Text>}
          </Box>

          {/* Right column: detail for the highlighted skill */}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth="50%" paddingLeft={2}>
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
