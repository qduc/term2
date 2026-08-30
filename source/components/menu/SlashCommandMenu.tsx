import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../../slash-commands.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  commands: SlashCommand[];
  selectedIndex: number;
  filter: string;
  scrollOffset?: number;
};

const COMMAND_COLUMN_WIDTH = 14;
const SEPARATOR_COLUMN_WIDTH = 3;

const SlashCommandMenu: FC<Props> = ({ commands, selectedIndex, filter, scrollOffset = 0 }) => {
  const filteredCommands = commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <MenuContainer
      items={filteredCommands}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      title="Commands"
      fallbackText="No matching commands"
      footer={
        <MenuFooter
          hints={[
            ['↑↓', 'navigate'],
            ['⏎', 'run'],
            ['esc', 'cancel'],
          ]}
        />
      }
      renderItem={(cmd, _index, isSelected) => (
        <Box key={cmd.name} width="100%">
          <SelectionMarker selected={isSelected} />
          <Box width={COMMAND_COLUMN_WIDTH} flexShrink={0}>
            <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected}>
              /{cmd.name}
            </Text>
          </Box>
          <Box width={SEPARATOR_COLUMN_WIDTH} flexShrink={0}>
            <Text color={COLOR_TEXT_SUBTLE}> -</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={isSelected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}>{cmd.description}</Text>
          </Box>
        </Box>
      )}
    />
  );
};

export default SlashCommandMenu;
