import React, { createContext, useContext } from 'react';
import { useSetting } from '../hooks/use-setting.js';
import { DEFAULT_THEME, THEMES } from './palettes.js';
import { resolveThemeName } from './resolve-theme.js';
/**
 * The default is the dark palette, not `undefined`: components rendered with no
 * provider (unit tests, one-off Ink roots) look exactly as they always have, and
 * `useTheme()` can never return nothing.
 */
const ThemeContext = createContext(DEFAULT_THEME);
export const useTheme = () => useContext(ThemeContext);
export const ThemeProvider = ({ theme, children }) => (React.createElement(ThemeContext.Provider, { value: theme }, children));
/**
 * Resolves `ui.theme` against the environment and provides the result. It
 * subscribes to the setting, so changing it in `/settings` recolours the UI
 * immediately. Lines already committed to the terminal's scrollback keep the
 * colours they were printed with — that output is no longer ours to repaint.
 */
export const SettingsThemeProvider = ({ settingsService, env = process.env, detectedBackground, children, }) => {
    const setting = useSetting(settingsService, 'ui.theme') ?? 'auto';
    const theme = THEMES[resolveThemeName(setting, { env, detectedBackground })];
    return React.createElement(ThemeProvider, { theme: theme }, children);
};
//# sourceMappingURL=ThemeContext.js.map