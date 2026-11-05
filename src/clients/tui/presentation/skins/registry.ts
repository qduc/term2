import { cardsSkin } from './cards/index.js';
import { classicSkin } from './classic/index.js';
import { ledgerSkin } from './ledger/index.js';
import type { SkinName } from './names.js';
import { railSkin } from './rail/index.js';
import type { Skin } from './types.js';
import { zenSkin } from './zen/index.js';

/** The complete selectable skin registry, checked against SkinName by the type system. */
const SKINS: Readonly<Record<SkinName, Skin>> = {
  classic: classicSkin,
  rail: railSkin,
  cards: cardsSkin,
  ledger: ledgerSkin,
  zen: zenSkin,
};

export const getSkin = (name: SkinName): Skin => SKINS[name];
