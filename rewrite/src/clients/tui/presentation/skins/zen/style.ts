import { useTheme } from '../../components/theme.js';
import type { Color } from '../../theme/palettes.js';

/**
 * Zen is almost all hierarchy and very little chrome, so the quiet levels have to
 * survive a palette with no colour at all. In `mono` every role resolves to
 * `undefined`; there the same ranking is carried by the terminal's `dim`
 * attribute instead, so "recedes" still reads as receding.
 */
export interface QuietStyle {
  color: Color;
  dimColor: boolean;
}

export interface ZenStyles {
  /** Secondary text that should still be read: settled tool calls, the model name. */
  quiet: QuietStyle;
  /** Furniture: separators, hints, elapsed times, reasoning. */
  faint: QuietStyle;
  /**
   * True when the palette has no colour. Anything that elsewhere relies on a tone
   * to stand out (a failure, a warning) must then stand out by weight instead.
   */
  colourless: boolean;
}

export function useZenStyles(): ZenStyles {
  const theme = useTheme();
  // A palette without colour (mono) answers `undefined` for every role.
  const colourless = theme.textSubtle === undefined;
  return {
    quiet: { color: theme.textMuted, dimColor: colourless },
    faint: { color: theme.textSubtle, dimColor: colourless },
    colourless,
  };
}

/** Columns the zen layers share: the marker column ("◆ ", "✓ ", "▲ ") and the indent under it. */
export const MARKER_COLUMNS = 2;
