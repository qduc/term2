import React, { createContext, useContext, type FC, type ReactNode } from 'react';
import { classicSkin } from './classic/index.js';
import type { Skin } from './types.js';
const SkinContext = createContext<Skin>(classicSkin);
export const useSkin = (): Skin => useContext(SkinContext);
export const SkinProvider: FC<{ skin: Skin; children?: ReactNode }> = ({ skin, children }) => (
  <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>
);
