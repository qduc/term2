import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { PathCompletionItem } from '../hooks/use-path-completion.js';

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
  if (loading) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text color="cyan">Loading project paths…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red">Unable to load paths: {error}</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text color="#64748b">No matches for "@{query}"</Text>
      </Box>
    );
  }

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text color="#64748b">
            @{query || '*'} · {items.length} suggestion
            {items.length === 1 ? '' : 's'}
          </Text>
          {items.length > maxHeight && (
            <Text color="#64748b">
              {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, items.length)}/{items.length}
            </Text>
          )}
        </Box>
        {hasScrollUp && <Text color="#64748b">↑ {scrollOffset} more</Text>}
        {visibleItems.map((item, visibleIndex) => {
          const actualIndex = scrollOffset + visibleIndex;
          const isSelected = actualIndex === selectedIndex;
          const icon = item.type === 'directory' ? '📁' : '📄';
          return (
            <Box key={item.path}>
              <Text color={isSelected ? 'cyan' : undefined} inverse={isSelected}>
                {icon} {item.path}
              </Text>
            </Box>
          );
        })}
        {hasScrollDown && <Text color="#64748b">↓ {items.length - scrollOffset - maxHeight} more</Text>}
      </Box>
      <Text color="#64748b">
        Enter → insert with space · Tab → insert w/o trailing space · Esc → cancel · ↑↓ → scroll
      </Text>
    </Box>
  );
};

export default PathSelectionMenu;
