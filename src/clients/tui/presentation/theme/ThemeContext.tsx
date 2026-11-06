import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import type { ISettingsService } from '../../../../shared/service-interfaces.js';
import { useSetting } from '../hooks/use-setting.js';
import { DEFAULT_THEME, THEMES, type ThemeTokens } from './palettes.js';
import { resolveThemeName, type BackgroundMode } from './resolve-theme.js';
const ThemeContext = createContext<ThemeTokens>(DEFAULT_THEME);
export const useTheme = (): ThemeTokens => useContext(ThemeContext);
export const ThemeProvider: FC<{ theme: ThemeTokens; children?: ReactNode }> = ({ theme, children }) => (
  <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
);

/** Resolves live `ui.theme`; startup terminal detection applies only to `auto`. */
export const SettingsThemeProvider: FC<{
  settingsService: ISettingsService;
  env?: Readonly<Record<string, string | undefined>>;
  detectedBackground?: BackgroundMode;
  children?: ReactNode;
}> = ({ settingsService, env = process.env, detectedBackground, children }) => {
  const setting = useSetting(settingsService, 'ui.theme') ?? 'auto';
  const theme = THEMES[resolveThemeName(setting, { env, detectedBackground })];
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};
