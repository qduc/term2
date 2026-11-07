/** Human receipt timing derived from accepted queue evidence, never provider dispatch time. */
import type { Item } from '../model/index.js';
import { advanceHumanClock, humanArrivalNotice } from '../shared/conversation/conversation-time-gap.js';
import type { DirectQueueRecord } from './queue-types.js';
import { isDirectHumanOrigin } from './origin.js';

/**
 * Attach model-only timing to its unchanged user item and advance the human receipt clock. The clock and
 * notice rules live in shared/conversation/conversation-time-gap.ts, shared with the delegation runtime. This
 * path decides which inputs are human (queue origin) and where a receipt comes from (the accepted queue
 * record). A human message with no recorded receipt is an unknown arrival, which breaks a known clock.
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
    if (item.type !== 'user_message' || (record && !isDirectHumanOrigin(record.request.origin))) {
      modelInput.push(item);
      continue;
    }
    const receivedAt = record?.receivedAt;
    const notice = receivedAt === undefined ? null : humanArrivalNotice(latestHumanInputAt, receivedAt);
    modelInput.push(notice ? { ...item, conversationTiming: notice } : item);
    latestHumanInputAt = advanceHumanClock(latestHumanInputAt, receivedAt);
  }
  return { latestHumanInputAt, modelInput };
}
