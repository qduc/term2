import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';

/**
 * "Ledger": dense and IDE-like. A header bar, role chips instead of glyph
 * prefixes, tool calls as aligned rows (tool, target, time, result), context and
 * quota gauges in a footer bar, and an approval with a risk meter.
 *
 * STUB: currently identical to classic. Override slots here; see
 * `docs/plans/theme-system.md` ("Building a skin") for the contract and rules.
 */
export const ledgerSkin: Skin = { ...classicSkin, name: 'ledger' };
