import type { ColorRole } from '../../theme/palettes.js';

/** Context usage at which a gauge turns from quiet to a warning, then to danger. */
export const CONTEXT_WARN_PERCENT = 75;
export const CONTEXT_DANGER_PERCENT = 90;

/**
 * The colour role for a usage percentage. Quiet until it matters: the point of a
 * gauge is that a nearly-full context is noticed *before* a compaction or a stall,
 * so every skin uses the same thresholds. An unknown percentage stays quiet.
 */
export function contextTone(percent: number | undefined): ColorRole {
  if (percent === undefined) return 'textSubtle';
  if (percent >= CONTEXT_DANGER_PERCENT) return 'danger';
  if (percent >= CONTEXT_WARN_PERCENT) return 'warning';
  return 'textSubtle';
}

/**
 * A fixed-width bar, `▰▰▰▱▱▱`, always exactly `cells` columns wide. Both glyphs are
 * single-cell, and a non-zero percentage always fills at least one cell, so "a
 * little" is never drawn as "none".
 */
export function gaugeBar(percent: number, cells: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const raw = Math.round((clamped / 100) * cells);
  const filled = clamped > 0 ? Math.max(1, raw) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}
