import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Box, measureElement, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
import type { MenuHint } from '../../skins/types.js';

export { SelectionMarker } from './SelectionMarker.js';
export type { MenuHint } from '../../skins/types.js';

/**
 * The standard key-hint footer. Every menu shows its hints in the same order
 * and the same format, so the reader learns the shape once; how that footer is
 * drawn belongs to the active skin.
 */
export const MenuFooter: React.FC<{ hints: ReadonlyArray<MenuHint> }> = ({ hints }) => {
  const { Hints } = useSkin();
  return <Hints hints={hints} />;
};

/** A compact, terminal-friendly scrollbar for a fixed-height menu list. */
export const MenuScrollbar: React.FC<{
  itemCount: number;
  scrollOffset: number;
  maxHeight: number;
  /** Measured terminal lines occupied by the visible rows. */
  visibleHeight?: number;
  /** Estimated terminal lines occupied by the complete list. */
  totalHeight?: number;
}> = ({
  itemCount,
  scrollOffset,
  maxHeight,
  visibleHeight: measuredVisibleHeight,
  totalHeight: measuredTotalHeight,
}) => {
  const theme = useTheme();
  const visibleHeight = measuredVisibleHeight ?? maxHeight;
  const totalHeight = measuredTotalHeight ?? itemCount;
  const maxScrollOffset = Math.max(1, totalHeight - visibleHeight);
  const scrollPosition =
    totalHeight === itemCount ? scrollOffset : (scrollOffset / Math.max(1, itemCount - maxHeight)) * maxScrollOffset;
  const thumbSize = Math.min(visibleHeight, Math.max(1, Math.round((visibleHeight * visibleHeight) / totalHeight)));
  const thumbStart = Math.round((scrollPosition / maxScrollOffset) * (visibleHeight - thumbSize));

  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: visibleHeight }, (_, index) => {
        const isThumb = index >= thumbStart && index < thumbStart + thumbSize;
        return (
          <Text key={index} color={isThumb ? theme.accent : theme.border}>
            {isThumb ? '┃' : '│'}
          </Text>
        );
      })}
    </Box>
  );
};

type Props<T> = {
  items: T[];
  selectedIndex: number;
  scrollOffset?: number;
  maxHeight?: number;
  /**
   * Defaults to the active-surface border. Pass a color only to signal state
   * (an error, say) — never to identify which menu this is; the title does that.
   */
  borderColor?: string;
  /** Shown dim on the first line inside the border. */
  title?: string;

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
  borderColor: borderColorOverride,
  title,
  loading = false,
  loadingText = 'Loading...',
  error = null,
  fallbackText,
  footer,
  footerOutsideBorder = false,
  isInactive,
  renderItem,
}: Props<T>) {
  const theme = useTheme();
  const borderColor = borderColorOverride ?? theme.borderActive;
  const rowRefs = useRef<Array<any>>([]);
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  useEffect(() => {
    if (!hasScrollUp && !hasScrollDown) return;
    const measured = visibleItems.map((_, index) => {
      const row = rowRefs.current[index];
      return row ? measureElement(row).height || 1 : 1;
    });
    setRowHeights((previous) =>
      measured.length === previous.length && measured.every((height, index) => height === previous[index])
        ? previous
        : measured,
    );
  }, [hasScrollDown, hasScrollUp, visibleItems, scrollOffset]);

  const { MenuFrame } = useSkin();
  const renderState = (state: ReactNode, color: string | undefined = borderColor) => (
    <MenuFrame title={title} borderColor={color} hasItems={false} footer={footer} footerPlacement="outside">
      {state}
    </MenuFrame>
  );

  if (loading) {
    return renderState(<Text color={theme.textSubtle}>{loadingText}</Text>);
  }

  if (error) {
    return renderState(<Text color={theme.danger}>{error}</Text>, theme.danger);
  }

  if (items.length === 0) {
    return renderState(
      typeof fallbackText === 'string' ? <Text color={theme.textSubtle}>{fallbackText}</Text> : fallbackText,
    );
  }

  const visibleHeight = rowHeights.reduce((sum, height) => sum + height, 0) || visibleItems.length;
  const averageRowHeight = visibleItems.length > 0 ? visibleHeight / visibleItems.length : 1;
  const totalHeight = Math.max(items.length, Math.round(items.length * averageRowHeight));

  // width="100%" keeps rows honest: without a definite container width the
  // rows size to their content, percentage min-widths (the narrow-terminal
  // wrap plans) resolve against nothing, and a wide terminal gets a
  // shrink-wrapped menu instead of full-width rows.
  return (
    <MenuFrame
      title={title}
      borderColor={borderColor}
      hasItems={true}
      footer={footer}
      footerPlacement={footerOutsideBorder ? 'outside' : 'inside'}
    >
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {visibleItems.map((item, visibleIndex) => {
            const actualIndex = scrollOffset + visibleIndex;
            const isSelected = actualIndex === selectedIndex;
            const isItemInactive = isInactive?.(item) || (item as any)?.inactive === true;
            const element = renderItem(item, actualIndex, isSelected, isItemInactive);
            let renderedElement = element;
            if (isItemInactive) {
              if (React.isValidElement(element) && element.type === Text) {
                renderedElement = React.cloneElement(element as React.ReactElement<any>, { color: theme.textSubtle });
              } else if (typeof element === 'string' || typeof element === 'number') {
                renderedElement = <Text color={theme.textSubtle}>{element}</Text>;
              }
            }
            return (
              <Box
                key={actualIndex}
                ref={(node) => {
                  rowRefs.current[visibleIndex] = node;
                }}
              >
                {renderedElement}
              </Box>
            );
          })}
        </Box>
        {hasScrollUp || hasScrollDown ? (
          <MenuScrollbar
            itemCount={items.length}
            scrollOffset={scrollOffset}
            maxHeight={maxHeight}
            visibleHeight={visibleHeight}
            totalHeight={totalHeight}
          />
        ) : null}
      </Box>
    </MenuFrame>
  );
}
