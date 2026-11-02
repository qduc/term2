import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SELECTED, useTheme } from '../theme.js';

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
export const SelectionMarker: React.FC<{ selected: boolean }> = ({ selected }) => {
  const theme = useTheme();
  return (
    <Box width={2} flexShrink={0}>
      <Text color={theme.accent} bold wrap="truncate">
        {selected ? `${GLYPH_SELECTED} ` : '  '}
      </Text>
    </Box>
  );
};
