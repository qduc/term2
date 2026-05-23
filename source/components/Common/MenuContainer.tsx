import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';

type Props<T> = {
  items: T[];
  selectedIndex: number;
  scrollOffset?: number;
  maxHeight?: number;
  borderColor: string;

  // Custom headers/titles
  title?: ReactNode;
  headerRight?: ReactNode; // e.g. pagination or queries

  // States
  loading?: boolean;
  loadingText?: string;
  error?: string | null;

  // Empty states
  fallbackText?: ReactNode;

  // Footer
  footer?: ReactNode;
  footerOutsideBorder?: boolean; // whether footer is inside the bordered box or outside it

  renderItem: (item: T, index: number, isSelected: boolean) => ReactNode;
};

export function MenuContainer<T>({
  items,
  selectedIndex,
  scrollOffset = 0,
  maxHeight = 10,
  borderColor,
  title,
  headerRight,
  loading = false,
  loadingText = 'Loading...',
  error = null,
  fallbackText,
  footer,
  footerOutsideBorder = false,
  renderItem,
}: Props<T>) {
  if (loading) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <Text color={borderColor}>{loadingText}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        {typeof fallbackText === 'string' ? <Text color="gray">{fallbackText}</Text> : fallbackText}
      </Box>
    );
  }

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const content = (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {(title || headerRight || items.length > maxHeight) && (
        <Box
          justifyContent="space-between"
          marginBottom={1}
          borderStyle="single"
          borderBottom={true}
          borderLeft={false}
          borderRight={false}
          borderTop={false}
          borderColor="gray"
        >
          <Box>
            {typeof title === 'string' ? (
              <Text bold color={borderColor}>
                {title}
              </Text>
            ) : (
              title
            )}
          </Box>
          <Box>
            {headerRight}
            {items.length > maxHeight && (
              <Text color="#64748b">
                {' '}
                · {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, items.length)}/{items.length}
              </Text>
            )}
          </Box>
        </Box>
      )}
      {hasScrollUp && <Text color="#64748b">↑ {scrollOffset} more</Text>}
      {visibleItems.map((item, visibleIndex) => {
        const actualIndex = scrollOffset + visibleIndex;
        const isSelected = actualIndex === selectedIndex;
        return renderItem(item, actualIndex, isSelected);
      })}
      {hasScrollDown && <Text color="#64748b">↓ {items.length - scrollOffset - maxHeight} more</Text>}
      {!footerOutsideBorder && footer && (
        <Box
          marginTop={1}
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        >
          {typeof footer === 'string' ? (
            <Text color="gray" dimColor>
              {footer}
            </Text>
          ) : (
            footer
          )}
        </Box>
      )}
    </Box>
  );

  if (footerOutsideBorder && footer) {
    return (
      <Box flexDirection="column">
        {content}
        {typeof footer === 'string' ? <Text color="#64748b">{footer}</Text> : footer}
      </Box>
    );
  }

  return content;
}
