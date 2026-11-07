/**
 * Human-arrival timing: the one policy for the model-only `[Conversation timing]` notice. The live turn path
 * uses `advanceHumanClock` and `humanArrivalNotice` through `session/time-gap.ts`. The history helpers below
 * (`withHumanInputTime`, `latestHumanInputAt`, `conversationTimeGap`, `formatConversationTimeGap`) serve only the
 * legacy runtime, which production never executes, and go with it (#197).
 *
 * The clock is the latest accepted human receipt. It only moves forward, and only on trustworthy evidence:
 * a canonical ISO timestamp. A malformed receipt poisons it for good, so a bad clock never produces a gap.
 * A gap of at least an hour between human arrivals yields a notice; shorter gaps, automatic input and
 * missing evidence yield none. Each path decides which inputs are human and where the receipt comes from.
 */
import type { ProviderInputItem } from '../contracts/provider-input.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

const TIME_GAP_MS = 60 * 60 * 1000;

/** Milliseconds for a canonical ISO timestamp; anything else is not evidence. */
function parseHumanReceipt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

/**
 * Advance the clock past one human arrival. `receivedAt` undefined means a human input whose arrival is
 * unknown: it breaks a known clock (no gap may span it) but cannot repair a poisoned one. Out-of-order
 * arrivals cannot move the clock back, and a malformed receipt replaces a valid clock with itself, which
 * keeps every later notice off.
 */
export function advanceHumanClock(clock: string | undefined, receivedAt: string | undefined): string | undefined {
  const previous = parseHumanReceipt(clock);
  if (receivedAt === undefined) return previous === undefined ? clock : undefined;
  const current = parseHumanReceipt(receivedAt);
  if (clock === undefined || (previous !== undefined && (current === undefined || current > previous)))
    return receivedAt;
  return clock;
}

/** The notice for a human arrival at `receivedAt` after the clock `previous`, or null when none is due. */
export function humanArrivalNotice(previous: unknown, receivedAt: unknown): string | null {
  const before = parseHumanReceipt(previous);
  const current = parseHumanReceipt(receivedAt);
  if (before === undefined || current === undefined || current - before < TIME_GAP_MS) return null;
  const minutes = Math.floor((current - before) / 60_000);
  return (
    `[Conversation timing] This human message arrived ${minutes} minutes after the previous human message ` +
    `(${previous} → ${receivedAt}). ` +
    'This is elapsed wall-clock time between human inputs, not necessarily agent inactivity. ' +
    'Use it as context; no need to mention it unless relevant.'
  );
}

type InputTimingOptions = {
  inputSource?: 'human' | 'automatic';
  suppressUserMessageDisplay?: boolean;
  replayFromHistory?: boolean;
  rolloverBrief?: boolean;
};

/** Stamp human arrival before queueing, not when the model eventually consumes it. */
export function withHumanInputTime(input: string | UserTurn, options: InputTimingOptions = {}): UserTurn {
  const turn = normalizeUserTurn(input);
  if (
    options.inputSource === 'automatic' ||
    options.suppressUserMessageDisplay ||
    options.replayFromHistory ||
    options.rolloverBrief
  ) {
    const { humanInputAt: _time, ...automatic } = turn;
    return automatic;
  }
  return { ...turn, humanInputAt: turn.humanInputAt ?? new Date().toISOString() };
}

/**
 * Latest trustworthy human arrival in delegation-runtime history, including the checkpoint carried by a
 * rollover brief. A user item without a stamp is automatic input there (`withHumanInputTime` strips it), so it
 * is skipped rather than treated as an unknown human arrival. A poisoned clock reads as no clock.
 */
export function latestHumanInputAt(history: readonly unknown[]): string | undefined {
  let clock: string | undefined;
  for (const candidate of history) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as ProviderInputItem;
    if (item.role !== 'user') continue;
    for (const value of [item.humanInputAt, item.humanInputBaseline])
      if (value !== undefined) clock = advanceHumanClock(clock, typeof value === 'string' ? value : String(value));
  }
  return parseHumanReceipt(clock) === undefined ? undefined : clock;
}

/** Keep the timing on its user item so replay and rewind cannot orphan a notice. */
export function conversationTimeGap(humanInputAt: string | undefined, history: readonly unknown[]): unknown {
  if (!humanInputAt) return undefined;
  const gap = { previousReceivedAt: latestHumanInputAt(history), receivedAt: humanInputAt };
  return formatConversationTimeGap(gap) ? gap : undefined;
}

/** Render a gap stored on a delegation-runtime user item; never infer missing timing. */
export function formatConversationTimeGap(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const gap = value as Record<string, unknown>;
  return humanArrivalNotice(gap.previousReceivedAt, gap.receivedAt);
}
