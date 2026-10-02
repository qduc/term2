import React, { type FC, type ReactNode } from 'react';
import { Text } from 'ink';
import { useTheme, type Color, type ColorRole } from '../../components/theme.js';

/**
 * The ledger's one visual unit: a short label on a surface, padded by a cell on
 * each side. Colour is only half of what makes it a chip. A theme with no surface
 * (`mono`, where `codeBackground` is undefined) would otherwise lose the chip
 * entirely and run its text into its neighbours, so the padding becomes brackets
 * there. The chip is the same width either way, which keeps width budgets honest.
 */
export interface ChipProps {
  /** Text colour; the surface chip is drawn in this tone. */
  tone?: ColorRole;
  bold?: boolean;
  /**
   * A filled chip: the tone becomes the background and the text takes the terminal's own
   * background (reverse video). That always contrasts as well as the tone does against
   * the terminal, and it still reads in `mono`, where it is plain reverse video.
   */
  solid?: boolean;
  /** Surface override, for chips with an identity colour of their own (a mode badge). */
  surface?: Color;
  /** Text colour on `surface`. */
  surfaceText?: Color;
  children: ReactNode;
}

export const Chip: FC<ChipProps> = ({ tone = 'textMuted', bold, solid, surface, surfaceText, children }) => {
  const theme = useTheme();
  const color = theme[tone];

  if (solid) {
    return (
      <Text inverse bold color={color}>
        {' '}
        {children}{' '}
      </Text>
    );
  }

  const background = surface ?? theme.codeBackground;
  if (background === undefined) {
    return (
      <Text color={color} bold={bold}>
        [{children}]
      </Text>
    );
  }

  return (
    <Text backgroundColor={background} color={surfaceText ?? color} bold={bold}>
      {' '}
      {children}{' '}
    </Text>
  );
};
