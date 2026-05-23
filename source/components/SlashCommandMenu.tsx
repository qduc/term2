import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../slash-commands.js';
import { MenuContainer } from './Common/MenuContainer.js';

type Props = {
  commands: SlashCommand[];
  selectedIndex: number;
  filter: string;
};

const SlashCommandMenu: FC<Props> = ({ commands, selectedIndex, filter }) => {
  const filteredCommands = commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <MenuContainer
      items={filteredCommands}
      selectedIndex={selectedIndex}
      borderColor="#22d3ee"
      fallbackText="No matching commands"
      renderItem={(cmd, _index, isSelected) => (
        <Box key={cmd.name}>
          <Text color={isSelected ? '#22d3ee' : undefined} bold={isSelected} inverse={isSelected}>
            {' '}
            /{cmd.name}{' '}
          </Text>
          <Text color="#64748b"> - {cmd.description}</Text>
        </Box>
      )}
    />
  );
};

export default SlashCommandMenu;
