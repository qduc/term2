import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import { MenuContainer } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_WARNING } from '../theme.js';

type Props = {
  items: PathCompletionItem[];
  selectedIndex: number;
  query: string;
  loading?: boolean;
  error?: string | null;
  warning?: string | null;
  scrollOffset?: number;
  maxHeight?: number;
};

const PathSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  query,
  loading = false,
  error = null,
  warning = null,
  scrollOffset = 0,
  maxHeight = 10,
}) => {
  return (
    <Box flexDirection="column">
      {warning && <Text color={COLOR_WARNING}>{warning}</Text>}
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        maxHeight={maxHeight}
        borderColor={COLOR_ACCENT}
        loading={loading}
        loadingText="Loading project paths…"
        error={error ? `Unable to load paths: ${error}` : null}
        fallbackText={`No matches for "@${query}"`}
        footer="Enter → insert with space · Tab → insert w/o trailing space · Esc → cancel · ↑↓ → scroll"
        footerOutsideBorder={true}
        renderItem={(item, _index, isSelected) => {
          const icon = item.type === 'directory' ? '📁' : '📄';
          return (
            <Box key={item.path}>
              <Text color={isSelected ? COLOR_ACCENT : undefined} inverse={isSelected}>
                {icon} {item.path}
              </Text>
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default PathSelectionMenu;
