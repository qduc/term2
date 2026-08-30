/**
 * Semantic color tokens for the terminal UI.
 *
 * Tokens are named for what they *mean*, not what they look like, so the same
 * idea renders the same way everywhere. Two rules keep it that way:
 *
 *  1. No hex literals outside this file. A one-off `#a78bfa` in a component is
 *     how the palette drifted to 29 colors before.
 *  2. No named terminal colors (`'green'`, `'yellow'`, `'gray'`). Those resolve
 *     against the *user's* terminal palette, so the app looks different on
 *     every machine and can land unreadable on light themes.
 */

// --- Brand -----------------------------------------------------------------

/** The single interactive accent: prompts, selection, user identity, focus. */
export const COLOR_ACCENT = '#22d3ee';
/** Secondary accent. Reserved for the mentor/second-model lane only. */
export const COLOR_ACCENT_ALT = '#a78bfa';

// --- Status ----------------------------------------------------------------

export const COLOR_SUCCESS = '#10b981';
export const COLOR_WARNING = '#f59e0b';
export const COLOR_DANGER = '#ef4444';
/** Softer danger, for body text under a danger heading. */
export const COLOR_DANGER_SOFT = '#f87171';

// --- Text ------------------------------------------------------------------

/** Primary body text. Left undefined in most places so the terminal default wins. */
export const COLOR_TEXT = '#e2e8f0';
/** Secondary text: values, metadata, tool output. */
export const COLOR_TEXT_MUTED = '#94a3b8';
/** Tertiary text: labels, hints, footers, separators. */
export const COLOR_TEXT_SUBTLE = '#64748b';

// --- Structure -------------------------------------------------------------

/** Dividers and inactive container borders. */
export const COLOR_BORDER = '#334155';
/** Borders of the surface that currently owns input. */
export const COLOR_BORDER_ACTIVE = COLOR_ACCENT;
/** Background behind inline code spans. */
export const COLOR_CODE_BACKGROUND = '#1e293b';

// --- Domain aliases --------------------------------------------------------
// These name a role in this app rather than a generic rank, so a future change
// to (say) reasoning text does not have to touch every subtle-gray caller.

/** Model reasoning / thinking transcript. */
export const COLOR_REASONING = COLOR_TEXT_SUBTLE;
/** Tool stdout and rendered tool results. */
export const COLOR_TOOL_OUTPUT = COLOR_TEXT_MUTED;
/** @deprecated Use COLOR_TEXT_SUBTLE (hints, labels) or COLOR_BORDER (rules). */
export const COLOR_MUTED = COLOR_TEXT_SUBTLE;

// --- Shared glyphs ---------------------------------------------------------
// Single-width on purpose. Emoji such as ⚠️ are double-width in most terminals
// and silently break every column alignment on the line they appear in.

export const GLYPH_SELECTED = '❯';
export const GLYPH_WARNING = '▲';
export const GLYPH_SEPARATOR = '│';

// --- Tool status -------------------------------------------------------------
// One glyph vocabulary for every tool line — shell commands, file edits, and
// nested subagent tool feeds all used to invent their own (⏸/▶, ✔/✖, a bare
// `$`, or `[toolName]`), so status meant something different depending on
// which renderer drew the line. Centralizing it here is what makes every tool
// line start in the same column with the same meaning.

export const TOOL_STATUS_GLYPH = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  rejected: '✗',
} as const;

export type ToolStatusKind = keyof typeof TOOL_STATUS_GLYPH;

export const TOOL_STATUS_COLOR: Record<ToolStatusKind, string> = {
  pending: COLOR_TEXT_SUBTLE,
  running: COLOR_WARNING,
  completed: COLOR_SUCCESS,
  failed: COLOR_DANGER,
  rejected: COLOR_DANGER,
};

// --- Mode identity ---------------------------------------------------------
// Each operating mode gets one badge color, so the mode is recognizable at a
// glance without reading the word. These are identity, not rank, which is why
// they are a closed map rather than reuses of the status tokens above.

export const MODE_BADGE_BACKGROUND = {
  STANDARD: '#0f766e',
  LITE: '#047857',
  SHELL: '#b45309',
  PLAN: '#0369a1',
  ORCHESTRATOR: '#9f1239',
  MENTOR: '#6d28d9',
} as const;

export type ModeBadge = keyof typeof MODE_BADGE_BACKGROUND;

/** Foreground for text sitting on a MODE_BADGE_BACKGROUND. */
export const MODE_BADGE_FOREGROUND = '#f8fafc';
