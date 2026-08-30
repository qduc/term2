import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';
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
 */
export const SelectionMarker: React.FC<{ selected: boolean }> = ({ selected }) => (
  <Text color={COLOR_ACCENT} bold>
    {selected ? `${GLYPH_SELECTED} ` : '  '}
  </Text>
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

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const content = (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {titleElement}
      {hasScrollUp && <Text color={COLOR_TEXT_SUBTLE}>↑ {scrollOffset} more</Text>}
      {visibleItems.map((item, visibleIndex) => {
        const actualIndex = scrollOffset + visibleIndex;
        const isSelected = actualIndex === selectedIndex;
        const isItemInactive = isInactive?.(item) || (item as any)?.inactive === true;
        const element = renderItem(item, actualIndex, isSelected, isItemInactive);
        if (isItemInactive) {
          if (React.isValidElement(element) && element.type === Text) {
            return React.cloneElement(element as React.ReactElement<any>, { color: COLOR_TEXT_SUBTLE });
          }
          if (typeof element === 'string' || typeof element === 'number') {
            return (
              <Box key={actualIndex}>
                <Text color={COLOR_TEXT_SUBTLE}>{element}</Text>
              </Box>
            );
          }
          return element;
        }
        return element;
      })}
      {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ {items.length - scrollOffset - maxHeight} more</Text>}
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
      <Box flexDirection="column">
        {content}
        {typeof footer === 'string' ? <Text color={COLOR_TEXT_SUBTLE}>{footer}</Text> : footer}
      </Box>
    );
  }

  return content;
}
