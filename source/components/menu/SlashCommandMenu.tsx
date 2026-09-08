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

/**
 * Width of the `/name` label column, sized to the longest command so short
 * names leave room for the description instead of padding it out, and capped
 * so one long name cannot eat the row. Computed from the full list (not the
 * filter) so the column does not jitter while typing. The label text
 * truncates rather than wrapping: the description carries the meaning.
 */
export const SLASH_COMMAND_LABEL_MAX_WIDTH = 20;

const SEPARATOR_COLUMN_WIDTH = 3;

const SlashCommandMenu: FC<Props> = ({ commands, selectedIndex, filter, scrollOffset = 0 }) => {
  const filteredCommands = commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase()));
  const labelColumnWidth = Math.min(
    Math.max(...commands.map((cmd) => cmd.name.length + 1), 8),
    SLASH_COMMAND_LABEL_MAX_WIDTH,
  );

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
        // flexWrap + minWidth is the narrow-terminal plan: while the
        // description has at least half the row it sits beside the label and
        // continuation lines align under it; below that it drops to its own
        // full-width line instead of squeezing into per-character fragments.
        <Box key={cmd.name} width="100%" flexDirection="row" flexWrap="wrap">
          <SelectionMarker selected={isSelected} />
          <Box width={labelColumnWidth} flexShrink={0}>
            <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected} wrap="truncate">
              /{cmd.name}
            </Text>
          </Box>
          <Box width={SEPARATOR_COLUMN_WIDTH} flexShrink={0}>
            <Text color={COLOR_TEXT_SUBTLE} wrap="truncate">
              {' '}
              -
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth="50%">
            <Text color={isSelected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}>{cmd.description}</Text>
          </Box>
        </Box>
      )}
    />
  );
};

export default SlashCommandMenu;
