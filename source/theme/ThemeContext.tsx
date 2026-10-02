import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import type { ISettingsService } from '../services/service-interfaces.js';
import { useSetting } from '../hooks/use-setting.js';
import { DEFAULT_THEME, THEMES, type ThemeTokens } from './palettes.js';
import { resolveThemeName, type BackgroundMode } from './resolve-theme.js';

/**
 * The default is the dark palette, not `undefined`: components rendered with no
 * provider (unit tests, one-off Ink roots) look exactly as they always have, and
 * `useTheme()` can never return nothing.
 */
const ThemeContext = createContext<ThemeTokens>(DEFAULT_THEME);

export const useTheme = (): ThemeTokens => useContext(ThemeContext);

export const ThemeProvider: FC<{ theme: ThemeTokens; children?: ReactNode }> = ({ theme, children }) => (
  <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
);

interface SettingsThemeProviderProps {
  settingsService: ISettingsService;
  /** Environment used to resolve `auto`; injectable so tests do not depend on the host terminal. */
  env?: Readonly<Record<string, string | undefined>>;
  /** What the terminal reported at startup (see `detectTerminalBackground`). */
  detectedBackground?: BackgroundMode;
  children?: ReactNode;
}

/**
 * Resolves `ui.theme` against the environment and provides the result. It
 * subscribes to the setting, so changing it in `/settings` recolours the UI
 * immediately. Lines already committed to the terminal's scrollback keep the
 * colours they were printed with — that output is no longer ours to repaint.
 */
export const SettingsThemeProvider: FC<SettingsThemeProviderProps> = ({
  settingsService,
  env = process.env,
  detectedBackground,
  children,
}) => {
  const setting = useSetting(settingsService, 'ui.theme') ?? 'auto';
  const theme = THEMES[resolveThemeName(setting, { env, detectedBackground })];
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};
