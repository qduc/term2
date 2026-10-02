/**
 * Built-in colour palettes.
 *
 * A palette is a complete set of *semantic* tokens, named for what they mean
 * rather than what they look like, so the same idea renders the same way
 * everywhere. Two rules keep that true:
 *
 *  1. No hex literals outside this directory (enforced by
 *     `no-raw-colors.guard.test.ts`). A one-off `#a78bfa` in a component is how
 *     the palette drifted to 29 colours before.
 *  2. No named terminal colours (`'green'`, `'gray'`). Those resolve against the
 *     *user's* terminal palette, so the app looks different on every machine and
 *     can land unreadable. Palettes use explicit `#rrggbb` instead.
 *
 * Contrast is a tested property, not a hope: see `palettes.test.ts`. A palette
 * declares which terminal backgrounds it is designed for in
 * `supportedBackgrounds`, and the test holds its body colours to WCAG 4.5:1 on
 * each of them.
 */

/** `undefined` lets the terminal's own default win, which is how `mono` works. */
export type Color = string | undefined;

export const THEME_NAMES = ['dark', 'light', 'high-contrast', 'mono'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * A colour a table or helper can name without holding a value: store the role,
 * then resolve it with `theme[role]` where the theme is in scope. This is what
 * lets module-level data (hint lists, label maps) stay theme-aware.
 */
export type ColorRole =
  | 'accent'
  | 'accentAlt'
  | 'success'
  | 'warning'
  | 'danger'
  | 'dangerSoft'
  | 'text'
  | 'textMuted'
  | 'textSubtle'
  | 'border'
  | 'borderActive'
  | 'codeBackground'
  | 'userBackground'
  | 'userText'
  | 'reasoning'
  | 'toolOutput';

export type ModeBadge = 'STANDARD' | 'LITE' | 'SHELL' | 'PLAN' | 'ORCHESTRATOR' | 'MENTOR';
export type ToolStatusKind = 'pending' | 'running' | 'completed' | 'failed' | 'rejected';

export interface ThemeTokens {
  name: ThemeName;
  /**
   * Terminal backgrounds this palette is designed to sit on. Used by the
   * contrast test and as documentation; empty for a palette that defines no
   * colours.
   */
  supportedBackgrounds: readonly string[];

  // --- Brand
  /** The single interactive accent: prompts, selection, user identity, focus. */
  accent: Color;
  /**
   * Secondary accent: work that runs outside the foreground turn — the mentor
   * lane, background tasks, queued follow-ups. Not a general-purpose highlight.
   */
  accentAlt: Color;

  // --- Status
  success: Color;
  warning: Color;
  danger: Color;
  /** Softer danger, for body text under a danger heading. */
  dangerSoft: Color;

  // --- Text
  /** Primary body text. Left undefined at most call sites so the terminal default wins. */
  text: Color;
  /** Secondary text: values, metadata, tool output. */
  textMuted: Color;
  /** Tertiary text: labels, hints, footers, separators. */
  textSubtle: Color;

  // --- Structure
  /** Dividers and inactive container borders. */
  border: Color;
  /** Borders of the surface that currently owns input. */
  borderActive: Color;
  /** Background behind inline code spans. */
  codeBackground: Color;

  // --- Domain aliases: a role in this app rather than a generic rank, so a
  // change to (say) reasoning text does not touch every subtle-grey caller.
  /** Full-width band behind user messages. */
  userBackground: Color;
  /**
   * Text on `userBackground`. Explicit on purpose: leaving it to the terminal
   * default put dark-on-dark text on light terminals (1.5:1).
   */
  userText: Color;
  /** Model reasoning / thinking transcript. */
  reasoning: Color;
  /** Tool stdout and rendered tool results. */
  toolOutput: Color;

  // --- Identity
  /** One badge colour per operating mode: identity, not rank. */
  modeBadge: Record<ModeBadge, Color>;
  /** Foreground for text sitting on a `modeBadge` background. */
  modeBadgeForeground: Color;
  /** Colour for each tool-line status glyph. */
  toolStatus: Record<ToolStatusKind, Color>;
}

const MODE_BADGES_ON_LIGHT_TEXT: Record<ModeBadge, string> = {
  STANDARD: '#0f766e',
  LITE: '#047857',
  SHELL: '#b45309',
  PLAN: '#0369a1',
  ORCHESTRATOR: '#9f1239',
  MENTOR: '#6d28d9',
};

const DARK: ThemeTokens = {
  name: 'dark',
  supportedBackgrounds: ['#0f172a', '#0d1117', '#000000'],
  accent: '#22d3ee',
  accentAlt: '#a78bfa',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  dangerSoft: '#f87171',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textSubtle: '#64748b',
  border: '#334155',
  borderActive: '#22d3ee',
  codeBackground: '#1e293b',
  userBackground: '#334155',
  userText: '#e2e8f0',
  reasoning: '#64748b',
  toolOutput: '#94a3b8',
  modeBadge: MODE_BADGES_ON_LIGHT_TEXT,
  modeBadgeForeground: '#f8fafc',
  toolStatus: {
    pending: '#64748b',
    running: '#f59e0b',
    completed: '#10b981',
    failed: '#ef4444',
    rejected: '#ef4444',
  },
};

const LIGHT: ThemeTokens = {
  name: 'light',
  supportedBackgrounds: ['#ffffff', '#f6f8fa'],
  accent: '#0e7490',
  accentAlt: '#6d28d9',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  dangerSoft: '#c81e1e',
  text: '#1e293b',
  textMuted: '#475569',
  textSubtle: '#64748b',
  border: '#cbd5e1',
  borderActive: '#0e7490',
  codeBackground: '#e2e8f0',
  userBackground: '#e2e8f0',
  userText: '#1e293b',
  reasoning: '#64748b',
  toolOutput: '#475569',
  modeBadge: MODE_BADGES_ON_LIGHT_TEXT,
  modeBadgeForeground: '#f8fafc',
  toolStatus: {
    pending: '#64748b',
    running: '#b45309',
    completed: '#15803d',
    failed: '#b91c1c',
    rejected: '#b91c1c',
  },
};

/** Maximum separation on a dark terminal, for low vision and bright rooms. */
const HIGH_CONTRAST: ThemeTokens = {
  name: 'high-contrast',
  supportedBackgrounds: ['#000000', '#0d1117'],
  accent: '#00e5ff',
  accentAlt: '#d8b4fe',
  success: '#4ade80',
  warning: '#ffd33d',
  danger: '#ff6b6b',
  dangerSoft: '#ff9a9a',
  text: '#ffffff',
  textMuted: '#e6e6e6',
  textSubtle: '#bfbfbf',
  border: '#8b949e',
  borderActive: '#00e5ff',
  codeBackground: '#262626',
  userBackground: '#ffffff',
  userText: '#000000',
  reasoning: '#bfbfbf',
  toolOutput: '#e6e6e6',
  modeBadge: {
    STANDARD: '#0f766e',
    LITE: '#047857',
    SHELL: '#92400e',
    PLAN: '#075985',
    ORCHESTRATOR: '#9f1239',
    MENTOR: '#6d28d9',
  },
  modeBadgeForeground: '#ffffff',
  toolStatus: {
    pending: '#bfbfbf',
    running: '#ffd33d',
    completed: '#4ade80',
    failed: '#ff6b6b',
    rejected: '#ff6b6b',
  },
};

const NO_COLOR_BADGES: Record<ModeBadge, Color> = {
  STANDARD: undefined,
  LITE: undefined,
  SHELL: undefined,
  PLAN: undefined,
  ORCHESTRATOR: undefined,
  MENTOR: undefined,
};

/**
 * No colour at all (`NO_COLOR`, `TERM=dumb`, or by choice). Everything falls
 * back to the terminal defaults; meaning has to survive on glyphs and weight.
 */
const MONO: ThemeTokens = {
  name: 'mono',
  supportedBackgrounds: [],
  accent: undefined,
  accentAlt: undefined,
  success: undefined,
  warning: undefined,
  danger: undefined,
  dangerSoft: undefined,
  text: undefined,
  textMuted: undefined,
  textSubtle: undefined,
  border: undefined,
  borderActive: undefined,
  codeBackground: undefined,
  userBackground: undefined,
  userText: undefined,
  reasoning: undefined,
  toolOutput: undefined,
  modeBadge: NO_COLOR_BADGES,
  modeBadgeForeground: undefined,
  toolStatus: {
    pending: undefined,
    running: undefined,
    completed: undefined,
    failed: undefined,
    rejected: undefined,
  },
};

export const THEMES: Readonly<Record<ThemeName, ThemeTokens>> = {
  dark: DARK,
  light: LIGHT,
  'high-contrast': HIGH_CONTRAST,
  mono: MONO,
};

export const DEFAULT_THEME: ThemeTokens = DARK;
