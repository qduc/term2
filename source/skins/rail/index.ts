import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';

/**
 * "Rail": quiet and typographic, no boxes or backgrounds. One-line tool calls
 * with a thin output rail, a plain prompt between two hairlines, a single-line
 * status, and an amber rail down the left of an approval.
 *
 * STUB: currently identical to classic. Override slots here; see
 * `docs/plans/theme-system.md` ("Building a skin") for the contract and rules.
 */
export const railSkin: Skin = { ...classicSkin, name: 'rail' };
