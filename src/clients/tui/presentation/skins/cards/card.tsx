import React, { type FC, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { Color } from '../../theme/palettes.js';

/**
 * Border shapes a card can take. Shape is meaning, not decoration: `double` marks
 * the riskiest approvals and `bold` marks a failed call, so both stay recognisable
 * in a terminal with no colour at all.
 */
export type CardShape = 'round' | 'double' | 'bold';

const TOP_CORNERS: Record<CardShape, { left: string; right: string; rule: string }> = {
  round: { left: '╭', right: '╮', rule: '─' },
  double: { left: '╔', right: '╗', rule: '═' },
  bold: { left: '┏', right: '┓', rule: '━' },
};

/** More rule glyphs than any terminal is wide; the rule box clips them to the room actually left. */
const RULE_OVERSHOOT = 400;

export interface CardProps {
  color: Color;
  shape?: CardShape;
  /**
   * Inline content set into the top border (`╭─ title ─────╮`). Ink has no border
   * titles, so the top edge is drawn by hand while the other three sides stay Ink's
   * own border, which sizes itself. Omit it for a plain bordered box.
   */
  title?: ReactNode;
  /** Shrink to the content instead of spanning the row. */
  fit?: boolean;
  children: ReactNode;
}

/**
 * A bordered box with one column of padding either side, so text inside starts
 * three columns in. The top rule is a flexible box rather than a fixed string,
 * which is what keeps the right corner on the right edge at every width.
 */
export const Card: FC<CardProps> = ({ color, shape = 'round', title, fit = false, children }) => {
  const body = (
    <Box
      flexDirection="column"
      borderStyle={shape}
      borderColor={color}
      borderTop={title === undefined}
      paddingX={1}
      flexGrow={fit ? 0 : 1}
    >
      {children}
    </Box>
  );

  if (title === undefined) {
    return (
      <Box flexDirection="column" alignSelf={fit ? 'flex-start' : undefined}>
        {body}
      </Box>
    );
  }

  const corners = TOP_CORNERS[shape];
  return (
    <Box flexDirection="column" alignSelf={fit ? 'flex-start' : undefined}>
      <Box>
        <Box flexShrink={0}>
          <Text color={color}>
            {corners.left}
            {corners.rule}{' '}
          </Text>
        </Box>
        <Box flexShrink={1}>{title}</Box>
        <Box flexShrink={0}>
          <Text color={color}> </Text>
        </Box>
        <Box flexGrow={1} flexBasis={0} minWidth={1} height={1} overflow="hidden">
          <Text color={color} wrap="wrap">
            {corners.rule.repeat(RULE_OVERSHOOT)}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={color}>{corners.right}</Text>
        </Box>
      </Box>
      {body}
    </Box>
  );
};
