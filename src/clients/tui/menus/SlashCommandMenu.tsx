import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from './slash-command-types.js';
import { MenuContainer, MenuFooter, SelectionMarker } from './MenuContainer.js';
import { useTheme } from '../presentation/components/theme.js';
import { SLASH_MENU_BINDINGS, bindingHints } from './menu-bindings.js';

type Props = {
  commands: SlashCommand[];
  selectedIndex: number;
  browsing: boolean;
  scrollOffset: number;
  visibleCount: number;
};

const SlashCommandMenu: FC<Props> = ({ commands, selectedIndex, browsing, scrollOffset, visibleCount }) => {
  const theme = useTheme();

  return (
    <MenuContainer
      items={commands}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={visibleCount}
      title="Commands"
      fallbackText="No matching commands"
      footer={<MenuFooter hints={bindingHints(SLASH_MENU_BINDINGS)} />}
      renderItem={(cmd, index, isSelected) => (
        <Box key={cmd.name} width="100%" flexDirection="column">
          {browsing && (index === scrollOffset || cmd.section !== commands[index - 1]?.section) && (
            <Text color={theme.accent} bold wrap="truncate-end">
              {cmd.section}
            </Text>
          )}
          <Box width="100%" gap={1}>
            <Box>
              <SelectionMarker selected={isSelected} />
              <Box width={13} flexShrink={0}>
                <Text color={isSelected ? theme.accent : theme.text} bold={isSelected}>
                  /{cmd.name}
                </Text>
              </Box>
            </Box>
            <Box flexGrow={1} flexShrink={1} flexBasis={0}>
              <Text color={isSelected ? theme.text : theme.textSubtle} wrap="truncate-end">
                {cmd.description}
              </Text>
            </Box>
          </Box>
        </Box>
      )}
    />
  );
};

export default SlashCommandMenu;
