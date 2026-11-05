import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import { DEFAULT_THEME, type ThemeTokens } from './palettes.js';
const ThemeContext = createContext<ThemeTokens>(DEFAULT_THEME);
export const useTheme = (): ThemeTokens => useContext(ThemeContext);
export const ThemeProvider: FC<{ theme: ThemeTokens; children?: ReactNode }> = ({ theme, children }) => (
  <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
);
