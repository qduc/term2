import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';

type Props<T> = {
  items: T[];
  selectedIndex: number;
  scrollOffset?: number;
  maxHeight?: number;
  borderColor: string;

  // States
  loading?: boolean;
  loadingText?: string;
  error?: string | null;

  // Empty states
  fallbackText?: ReactNode;

  // Footer
  footer?: ReactNode;
  footerOutsideBorder?: boolean; // whether footer is inside the bordered box or outside it

  isInactive?: (item: T) => boolean;
  renderItem: (item: T, index: number, isSelected: boolean, isInactive: boolean) => ReactNode;
};

export function MenuContainer<T>({
  items,
  selectedIndex,
  scrollOffset = 0,
  maxHeight = 10,
  borderColor,
  loading = false,
  loadingText = 'Loading...',
  error = null,
  fallbackText,
  footer,
  footerOutsideBorder = false,
  isInactive,
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
      {hasScrollUp && <Text color="#64748b">↑ {scrollOffset} more</Text>}
      {visibleItems.map((item, visibleIndex) => {
        const actualIndex = scrollOffset + visibleIndex;
        const isSelected = actualIndex === selectedIndex;
        const isItemInactive = isInactive?.(item) || (item as any)?.inactive === true;
        const element = renderItem(item, actualIndex, isSelected, isItemInactive);
        if (isItemInactive) {
          if (React.isValidElement(element) && element.type === Text) {
            return React.cloneElement(element as React.ReactElement<any>, { color: 'gray' });
          }
          if (typeof element === 'string' || typeof element === 'number') {
            return (
              <Box key={actualIndex}>
                <Text color="gray">{element}</Text>
              </Box>
            );
          }
          return element;
        }
        return element;
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
