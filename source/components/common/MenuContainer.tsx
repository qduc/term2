import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Box, measureElement, Text } from 'ink';
import {
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_BORDER_ACTIVE,
  COLOR_DANGER,
  COLOR_TEXT_SUBTLE,
  GLYPH_SELECTED,
  GLYPH_SEPARATOR,
} from '../theme.js';

/**
 * The selection marker every menu row starts with. A gutter marker beats
 * `inverse`, which paints the row with the *terminal's* background color and so
 * looks harsh (and differs machine to machine). It also keeps every row's text
 * on the same left edge, selected or not.
 *
 * The fixed-width, non-shrinking wrapper is the point: without it Yoga steals
 * the gutter's cells first on narrow terminals (the marker collapses to `❯/`
 * and then vanishes), so every row must treat this as an inflexible 2-cell
 * gutter, never as shrinkable text.
 */
export const SelectionMarker: React.FC<{ selected: boolean }> = ({ selected }) => (
  <Box width={2} flexShrink={0}>
    <Text color={COLOR_ACCENT} bold wrap="truncate">
      {selected ? `${GLYPH_SELECTED} ` : '  '}
    </Text>
  </Box>
);

/**
 * The standard key-hint footer. Every menu shows its hints in the same order
 * and the same format, so the reader learns the shape once. Menus used to each
 * invent their own wording, separator, and arrow glyph.
 */
export const MenuFooter: React.FC<{ hints: ReadonlyArray<[key: string, action: string]> }> = ({ hints }) => (
  <Text color={COLOR_TEXT_SUBTLE}>
    {hints.map(([key, action], index) => (
      <React.Fragment key={key}>
        {index > 0 ? ` ${GLYPH_SEPARATOR} ` : ''}
        {key} {action}
      </React.Fragment>
    ))}
  </Text>
);

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
          <Text key={index} color={isThumb ? COLOR_ACCENT : COLOR_BORDER}>
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
  borderColor = COLOR_BORDER_ACTIVE,
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

  const titleElement = title ? <Text color={COLOR_TEXT_SUBTLE}>{title}</Text> : null;

  if (loading) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        {titleElement}
        <Text color={COLOR_TEXT_SUBTLE}>{loadingText}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box borderStyle="round" borderColor={COLOR_DANGER} paddingX={1} flexDirection="column">
        {titleElement}
        <Text color={COLOR_DANGER}>{error}</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        {titleElement}
        {typeof fallbackText === 'string' ? <Text color={COLOR_TEXT_SUBTLE}>{fallbackText}</Text> : fallbackText}
      </Box>
    );
  }

  const visibleHeight = rowHeights.reduce((sum, height) => sum + height, 0) || visibleItems.length;
  const averageRowHeight = visibleItems.length > 0 ? visibleHeight / visibleItems.length : 1;
  const totalHeight = Math.max(items.length, Math.round(items.length * averageRowHeight));

  // width="100%" keeps rows honest: without a definite container width the
  // rows size to their content, percentage min-widths (the narrow-terminal
  // wrap plans) resolve against nothing, and a wide terminal gets a
  // shrink-wrapped menu instead of full-width rows.
  const content = (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column" width="100%">
      {titleElement}
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
                renderedElement = React.cloneElement(element as React.ReactElement<any>, { color: COLOR_TEXT_SUBTLE });
              } else if (typeof element === 'string' || typeof element === 'number') {
                renderedElement = <Text color={COLOR_TEXT_SUBTLE}>{element}</Text>;
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
      {!footerOutsideBorder && footer && (
        <Box
          marginTop={1}
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={COLOR_BORDER}
        >
          {typeof footer === 'string' ? <Text color={COLOR_TEXT_SUBTLE}>{footer}</Text> : footer}
        </Box>
      )}
    </Box>
  );

  if (footerOutsideBorder && footer) {
    return (
      <Box flexDirection="column" width="100%">
        {content}
        {typeof footer === 'string' ? <Text color={COLOR_TEXT_SUBTLE}>{footer}</Text> : footer}
      </Box>
    );
  }

  return content;
}
