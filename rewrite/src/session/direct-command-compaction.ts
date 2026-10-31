/** Actual native manual compaction preparation; only Session may accept its resulting replacement. */
import { isDeepStrictEqual } from 'node:util';
import {
  compactDirectHistory,
  type DirectCompactionInput,
  type DirectCompactionResult,
} from '../engine/direct-recovery-compaction.js';
import type { DirectHistoryFact } from './facts.js';
import type { DirectCommandSnapshot } from './direct-command-types.js';

export type DirectManualCompactionPlan =
  | { readonly kind: 'rejected'; readonly code: 'busy' | 'stale'; readonly message: string }
  | { readonly kind: 'not_compacted'; readonly result: Exclude<DirectCompactionResult, { kind: 'compacted' }> }
  | {
      readonly kind: 'replace';
      readonly expectedRevision: string;
      readonly fact: DirectHistoryFact;
      readonly clearContinuity: true;
      readonly result: Extract<DirectCompactionResult, { kind: 'compacted' }>;
    };

/**
 * Invoke the real compactor against an owned settled capture. No append, receipt,
 * hidden retry, provider substitute or no-op success. Session supplies the actual
 * model/request/settings/signal/accounting and retains its command reservation
 * across await; cancellation/errors propagate, including already-incurred costs.
 */
export async function prepareDirectManualCompaction(
  snapshot: DirectCommandSnapshot,
  input: Omit<DirectCompactionInput, 'manual'>,
): Promise<DirectManualCompactionPlan> {
  if (!snapshot.executionsSettled)
    return { kind: 'rejected', code: 'busy', message: 'Foreground execution and cleanup must settle first.' };
  if (!isDeepStrictEqual(snapshot.history, input.request.input))
    return { kind: 'rejected', code: 'stale', message: 'Compaction request differs from the owned history capture.' };
  // Own transcript data while retaining live request capabilities (notably the
  // engine recovery reservation, whose prototype cannot be structured-cloned).
  const request = { ...input.request, input: structuredClone(input.request.input) };
  const result = await compactDirectHistory({ ...input, request, manual: true });
  if (result.kind !== 'compacted') return { kind: 'not_compacted', result };
  return {
    kind: 'replace',
    expectedRevision: snapshot.revision,
    clearContinuity: true,
    result,
    fact: {
      type: 'history_replaced',
      reason: 'compaction',
      history: structuredClone(result.history),
      rearmAtEstimatedTokens: result.rearmAtEstimatedTokens,
      checkpointReceipts: structuredClone(result.checkpointReceipts),
    },
  };
}
