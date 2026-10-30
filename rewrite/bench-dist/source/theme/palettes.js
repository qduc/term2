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
export const THEME_NAMES = ['dark', 'light', 'high-contrast', 'mono'];
const MODE_BADGES_ON_LIGHT_TEXT = {
    STANDARD: '#0f766e',
    BARE: '#0f766e',
    PAIR: '#0f766e',
    LITE: '#047857',
    SHELL: '#b45309',
    PLAN: '#0369a1',
    ORCHESTRATOR: '#9f1239',
    MENTOR: '#6d28d9',
};
const DARK = {
    name: 'dark',
    supportedBackgrounds: ['#0f172a', '#0d1117', '#000000'],
    accent: '#22d3ee',
    accentAlt: '#a78bfa',
    success: '#10b981',
    warning: '#f59e0b',
    // Not #ef4444: on the pill/inline-code surface (#1e293b) that measured 3.9:1.
    danger: '#f46060',
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
        failed: '#f46060',
        rejected: '#f46060',
    },
};
const LIGHT = {
    name: 'light',
    supportedBackgrounds: ['#ffffff', '#f6f8fa'],
    // Accent, success and warning are a step darker than the Tailwind 700s: on the pill/inline-code
    // surface (#e2e8f0) those measured 4.1-4.3:1.
    accent: '#0d6c85',
    accentAlt: '#6d28d9',
    success: '#147539',
    warning: '#a64c08',
    danger: '#b91c1c',
    dangerSoft: '#c81e1e',
    text: '#1e293b',
    textMuted: '#475569',
    textSubtle: '#64748b',
    border: '#cbd5e1',
    borderActive: '#0d6c85',
    codeBackground: '#e2e8f0',
    userBackground: '#e2e8f0',
    userText: '#1e293b',
    reasoning: '#64748b',
    toolOutput: '#475569',
    modeBadge: MODE_BADGES_ON_LIGHT_TEXT,
    modeBadgeForeground: '#f8fafc',
    toolStatus: {
        pending: '#64748b',
        running: '#a64c08',
        completed: '#147539',
        failed: '#b91c1c',
        rejected: '#b91c1c',
    },
};
/** Maximum separation on a dark terminal, for low vision and bright rooms. */
const HIGH_CONTRAST = {
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
        BARE: '#0f766e',
        PAIR: '#0f766e',
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
const NO_COLOR_BADGES = {
    STANDARD: undefined,
    BARE: undefined,
    PAIR: undefined,
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
const MONO = {
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
export const THEMES = {
    dark: DARK,
    light: LIGHT,
    'high-contrast': HIGH_CONTRAST,
    mono: MONO,
};
export const DEFAULT_THEME = DARK;
//# sourceMappingURL=palettes.js.map