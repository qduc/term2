import { cardsSkin } from './cards/index.js';
import { classicSkin } from './classic/index.js';
import { ledgerSkin } from './ledger/index.js';
import type { SkinName } from './names.js';
import { railSkin } from './rail/index.js';
import type { Skin } from './types.js';
import { zenSkin } from './zen/index.js';

/** Every skin by name. A test pins this to `SKIN_NAMES`, so a skin cannot be selectable without being registered. */
export const SKINS: Readonly<Record<SkinName, Skin>> = {
  classic: classicSkin,
  rail: railSkin,
  cards: cardsSkin,
  ledger: ledgerSkin,
  zen: zenSkin,
};

export const getSkin = (name: SkinName): Skin => SKINS[name];
