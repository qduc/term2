import React, { createContext, useContext } from 'react';
import { useSetting } from '../hooks/use-setting.js';
import { classicSkin } from './classic/index.js';
import { DEFAULT_SKIN_NAME } from './names.js';
import { getSkin } from './registry.js';
/**
 * The default is the classic skin, not `undefined`: components rendered with no
 * provider (the existing unit tests, one-off Ink roots) look exactly as they
 * always have, and `useSkin()` can never return nothing.
 */
const SkinContext = createContext(classicSkin);
export const useSkin = () => useContext(SkinContext);
export const SkinProvider = ({ skin, children }) => (React.createElement(SkinContext.Provider, { value: skin }, children));
/**
 * Provides the skin named by `ui.skin`, and re-renders when it changes.
 * Lines already committed to the terminal's scrollback keep the layout they were
 * printed with, exactly as they keep their colours.
 */
export const SettingsSkinProvider = ({ settingsService, children, }) => {
    const name = useSetting(settingsService, 'ui.skin') ?? DEFAULT_SKIN_NAME;
    return React.createElement(SkinProvider, { skin: getSkin(name) }, children);
};
//# sourceMappingURL=SkinContext.js.map