/** Human receipt timing derived from accepted queue evidence, never provider dispatch time. */
import type { Item } from '../model/index.js';
import type { DirectQueueRecord } from './queue-types.js';
import { isDirectHumanOrigin } from './origin.js';

const timestamp = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
};

/**
 * Attach model-only timing to its unchanged user item and advance the
 * monotonic human receipt clock. Missing human receipt evidence resets a known clock to unknown, never "now".
 * A malformed accepted human receipt poisons timing, including after rotation.
 * Live admission and replay use this same projection; no extra log fact is needed.
 */
export function planDirectTiming(
  previousReceivedAt: string | undefined,
  records: readonly DirectQueueRecord[],
  input: readonly Item[],
): { readonly latestHumanInputAt: string | undefined; readonly modelInput: readonly Item[] } {
  let latestHumanInputAt = previousReceivedAt;
  const modelInput: Item[] = [];
  for (const item of input) {
    const record = item.type === 'user_message' ? records.find((record) => record.messageId === item.id) : undefined;
    if (item.type === 'user_message' && (!record || isDirectHumanOrigin(record.request.origin))) {
      if (record?.receivedAt === undefined) {
        // An unknown human arrival breaks a known baseline, but cannot repair poison.
        if (timestamp(latestHumanInputAt) !== undefined) latestHumanInputAt = undefined;
        modelInput.push(item);
        continue;
      }
      const previous = timestamp(latestHumanInputAt);
      const current = timestamp(record.receivedAt);
      if (previous !== undefined && current !== undefined && current - previous >= 60 * 60 * 1000) {
        const minutes = Math.floor((current - previous) / 60_000);
        modelInput.push({
          ...item,
          conversationTiming:
            `[Conversation timing] This human message arrived ${minutes} minutes after the previous human message ` +
            `(${latestHumanInputAt} → ${record.receivedAt}). ` +
            'This is elapsed wall-clock time between human inputs, not necessarily agent inactivity. ' +
            'Use it as context; no need to mention it unless relevant.',
        });
      } else modelInput.push(item);
      // Invalid evidence is sticky; out-of-order dispatch cannot move time back.
      if (latestHumanInputAt === undefined || (previous !== undefined && (current === undefined || current > previous)))
        latestHumanInputAt = record.receivedAt;
    } else modelInput.push(item);
  }
  return { latestHumanInputAt, modelInput };
}
