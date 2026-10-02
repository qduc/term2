import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import type { ISettingsService } from '../services/service-interfaces.js';
import { useSetting } from '../hooks/use-setting.js';
import { classicSkin } from './classic/index.js';
import { DEFAULT_SKIN_NAME } from './names.js';
import { getSkin } from './registry.js';
import type { Skin } from './types.js';

/**
 * The default is the classic skin, not `undefined`: components rendered with no
 * provider (the existing unit tests, one-off Ink roots) look exactly as they
 * always have, and `useSkin()` can never return nothing.
 */
const SkinContext = createContext<Skin>(classicSkin);

export const useSkin = (): Skin => useContext(SkinContext);

export const SkinProvider: FC<{ skin: Skin; children?: ReactNode }> = ({ skin, children }) => (
  <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>
);

/**
 * Provides the skin named by `ui.skin`, and re-renders when it changes.
 * Lines already committed to the terminal's scrollback keep the layout they were
 * printed with, exactly as they keep their colours.
 */
export const SettingsSkinProvider: FC<{ settingsService: ISettingsService; children?: ReactNode }> = ({
  settingsService,
  children,
}) => {
  const name = useSetting(settingsService, 'ui.skin') ?? DEFAULT_SKIN_NAME;
  return <SkinProvider skin={getSkin(name)}>{children}</SkinProvider>;
};
