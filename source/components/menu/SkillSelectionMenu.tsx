import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  items: SkillInfo[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const SkillSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query }) => {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <MenuFrame
          title="Skills"
          borderColor={theme.borderActive}
          hasItems={false}
          footer={<MenuFooter hints={[['Esc', 'cancel']]} />}
          footerPlacement="outside"
        >
          <Text color={theme.textSubtle}>{query ? 'No matching skills' : 'No skills available'}</Text>
        </MenuFrame>
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
      <MenuFrame
        title="Skills"
        borderColor={theme.borderActive}
        hasItems={true}
        footer={
          <MenuFooter
            hints={[
              ['↑↓', 'navigate'],
              ['⏎', 'select'],
              ['Esc', 'cancel'],
            ]}
          />
        }
        footerPlacement="outside"
      >
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
            borderColor={theme.border}
            paddingRight={1}
          >
            <Box flexDirection="row" width="100%">
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                {visibleItems.map((skill, visibleIndex) => {
                  const actualIndex = scrollOffset + visibleIndex;
                  const isSelected = actualIndex === selectedIndex;
                  return (
                    <Box key={skill.name}>
                      <SelectionMarker selected={isSelected} />
                      <Text color={isSelected ? theme.accent : undefined} bold={isSelected} wrap="truncate">
                        {skill.name}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
              {hasScrollUp || hasScrollDown ? (
                <MenuScrollbar itemCount={items.length} scrollOffset={scrollOffset} maxHeight={maxHeight} />
              ) : null}
            </Box>
          </Box>

          {/* Right column: detail for the highlighted skill */}
          <Box flexDirection="column" width="50%" paddingLeft={2}>
            {selectedSkill && (
              <Box flexDirection="column">
                <Text bold color={theme.accent}>
                  {selectedSkill.name}
                </Text>
                <Box marginTop={1}>
                  <Text color={theme.text}>{selectedSkill.description}</Text>
                </Box>
                <Box marginTop={1}>
                  <Text color={theme.textSubtle}>
                    Scope: {selectedSkill.isProjectLevel ? 'Project level' : 'Global'}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      </MenuFrame>
    </Box>
  );
};

export default SkillSelectionMenu;
