import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';

/**
 * "Cards": every message and tool call in its own rounded card, a boxed input
 * with the key hints on its bottom border, status as pills, and an approval box
 * with button chips.
 *
 * STUB: currently identical to classic. Override slots here; see
 * `docs/plans/theme-system.md` ("Building a skin") for the contract and rules.
 */
export const cardsSkin: Skin = { ...classicSkin, name: 'cards' };
