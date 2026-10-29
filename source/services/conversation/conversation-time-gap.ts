import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';

const TIME_GAP_MS = 60 * 60 * 1000;

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

const timestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
};

/** Keep the timing on its user item so replay and rewind cannot orphan a notice. */
export function conversationTimeGap(humanInputAt: string | undefined, history: readonly unknown[]): unknown {
  if (!humanInputAt) return undefined;
  let previousReceivedAt: string | undefined;
  let latest = -Infinity;
  // Released steers may execute ahead of older queued follow-ups. History order
  // must not move the human arrival clock backwards in that case.
  for (const candidate of history) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as ProviderInputItem;
    if (item.role !== 'user' || item.humanInputAt === undefined) continue;
    const received = timestamp(item.humanInputAt);
    if (received === null) return undefined;
    if (received > latest) {
      latest = received;
      previousReceivedAt = item.humanInputAt as string;
    }
  }
  const gap = { previousReceivedAt, receivedAt: humanInputAt };
  return formatConversationTimeGap(gap) ? gap : undefined;
}

/** Render only trustworthy forward clock differences; never infer missing timing. */
export function formatConversationTimeGap(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const gap = value as Record<string, unknown>;
  const previous = timestamp(gap.previousReceivedAt);
  const current = timestamp(gap.receivedAt);
  if (previous === null || current === null || current - previous < TIME_GAP_MS) return null;
  const minutes = Math.floor((current - previous) / 60_000);
  return (
    `[Conversation timing] This human message arrived ${minutes} minutes after the previous human message ` +
    `(${gap.previousReceivedAt} → ${gap.receivedAt}). ` +
    'This is elapsed wall-clock time between human inputs, not necessarily agent inactivity. ' +
    'Use it as context; no need to mention it unless relevant.'
  );
}
