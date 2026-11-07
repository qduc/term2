import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import type { ISettingsService } from '../../../../shared/service-interfaces.js';
import { useSetting } from '../hooks/use-setting.js';
import { classicSkin } from './classic/index.js';
import { DEFAULT_SKIN_NAME } from '../../../../config/skins/names.js';
import { getSkin } from './registry.js';
import type { Skin } from './types.js';
const SkinContext = createContext<Skin>(classicSkin);
export const useSkin = (): Skin => useContext(SkinContext);
export const SkinProvider: FC<{ skin: Skin; children?: ReactNode }> = ({ skin, children }) => (
  <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>
);

/** Provides the live `ui.skin`; committed terminal scrollback retains its layout. */
export const SettingsSkinProvider: FC<{ settingsService: ISettingsService; children?: ReactNode }> = ({
  settingsService,
  children,
}) => {
  const name = useSetting(settingsService, 'ui.skin') ?? DEFAULT_SKIN_NAME;
  return <SkinProvider skin={getSkin(name)}>{children}</SkinProvider>;
};
