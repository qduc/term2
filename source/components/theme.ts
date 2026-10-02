/**
 * Terminal UI theme: the public entry for components.
 *
 * Colours are not constants here any more. They come from the active theme, so
 * a component asks `useTheme()` for a *meaning* (`theme.danger`, `theme.textSubtle`)
 * and the user's `ui.theme` setting decides what that looks like. Palettes live
 * in `source/theme/palettes.ts`; do not write a hex literal or a named terminal
 * colour (`'green'`, `'gray'`) in a component — `no-raw-colors.guard.test.ts`
 * enforces it.
 *
 * What stays here is what does not vary by palette: the shared glyph vocabulary.
 */

export { useTheme, ThemeProvider, SettingsThemeProvider } from '../theme/ThemeContext.js';
export type { ThemeTokens, ThemeName, ModeBadge, ToolStatusKind, Color, ColorRole } from '../theme/palettes.js';

import type { ToolStatusKind } from '../theme/palettes.js';

// --- Shared glyphs ---------------------------------------------------------
// Single-width on purpose. Emoji such as ⚠️ are double-width in most terminals
// and silently break every column alignment on the line they appear in.

export const GLYPH_SELECTED = '❯';
export const GLYPH_WARNING = '▲';
export const GLYPH_SEPARATOR = '│';
export const GLYPH_FAVORITE = '★';

// --- Tool status -------------------------------------------------------------
// One glyph vocabulary for every tool line — shell commands, file edits, and
// nested subagent tool feeds all used to invent their own (⏸/▶, ✔/✖, a bare
// `$`, or `[toolName]`), so status meant something different depending on
// which renderer drew the line. Centralizing it here is what makes every tool
// line start in the same column with the same meaning. The colour for each
// status is `theme.toolStatus[kind]`.

export const TOOL_STATUS_GLYPH = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  rejected: '✗',
} as const satisfies Record<ToolStatusKind, string>;
