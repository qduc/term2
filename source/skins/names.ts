/**
 * The names a `ui.skin` setting may hold. Kept free of React so the settings
 * schema can import it without pulling the UI into the service layer; the
 * skins themselves are registered in `registry.ts`, and a test pins the two lists
 * together.
 */
export const SKIN_NAMES = ['classic', 'rail', 'cards', 'ledger', 'zen'] as const;
export type SkinName = (typeof SKIN_NAMES)[number];

export const DEFAULT_SKIN_NAME: SkinName = 'classic';
