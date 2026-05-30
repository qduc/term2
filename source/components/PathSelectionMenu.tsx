import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { PathCompletionItem } from '../hooks/use-path-completion.js';
import { MenuContainer } from './Common/MenuContainer.js';

type Props = {
  items: PathCompletionItem[];
  selectedIndex: number;
  query: string;
  loading?: boolean;
  error?: string | null;
  scrollOffset?: number;
  maxHeight?: number;
};

const PathSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  query,
  loading = false,
  error = null,
  scrollOffset = 0,
  maxHeight = 10,
}) => {
  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={maxHeight}
      borderColor="cyan"
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
            <Text color={isSelected ? 'cyan' : undefined} inverse={isSelected}>
              {icon} {item.path}
            </Text>
          </Box>
        );
      }}
    />
  );
};

export default PathSelectionMenu;
