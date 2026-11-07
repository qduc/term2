export const THEME_NAMES = ['dark', 'light', 'high-contrast', 'mono'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** What `ui.theme` may hold: a concrete palette, or `auto` to pick one for the terminal. */
export type ThemeSetting = 'auto' | ThemeName;
export const THEME_SETTING_VALUES = ['auto', ...THEME_NAMES] as const;
