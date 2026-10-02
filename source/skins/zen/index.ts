import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';

/**
 * "Zen": conversation first. Generous whitespace, tool calls collapsed into a
 * one-line summary with only failures expanded, a borderless prompt, a nearly
 * hidden status line that speaks up only when something needs attention, and an
 * approval that reads as a single sentence with one-key answers.
 *
 * STUB: currently identical to classic. Override slots here; see
 * `docs/plans/theme-system.md` ("Building a skin") for the contract and rules.
 */
export const zenSkin: Skin = { ...classicSkin, name: 'zen' };
