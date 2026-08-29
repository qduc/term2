import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../../slash-commands.js';
import { MenuContainer } from '../common/MenuContainer.js';

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
      borderColor="#22d3ee"
      fallbackText="No matching commands"
      renderItem={(cmd, _index, isSelected) => (
        <Box key={cmd.name} width="100%">
          <Box width={COMMAND_COLUMN_WIDTH} flexShrink={0}>
            <Text color={isSelected ? '#22d3ee' : undefined} bold={isSelected} inverse={isSelected}>
              {' '}
              /{cmd.name}
            </Text>
          </Box>
          <Box width={SEPARATOR_COLUMN_WIDTH} flexShrink={0}>
            <Text color={isSelected ? '#22d3ee' : '#64748b'}> -</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={isSelected ? 'white' : '#64748b'}>{cmd.description}</Text>
          </Box>
        </Box>
      )}
    />
  );
};

export default SlashCommandMenu;
