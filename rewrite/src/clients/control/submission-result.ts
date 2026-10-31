/** Encode authoritative submission records as v1 receipts and bridge outcomes.
 * Missing answer evidence stays pending; stage/outcome, never array disappearance,
 * settles queued work that never obtained a turn.
 */
import type { WireAdmission, WireSnapshot, WireSubmissionRecord } from '../../protocol/direct-wire.js';
import type { BridgeOutcome, ControlBridgeResult, ControlMutationReceipt } from './transport.js';

/** Keep original admission identity/delivery, including a replayed rejection. */
export function admissionReceipt(admission: WireAdmission): ControlMutationReceipt {
  const replayed = admission.kind === 'duplicate';
  const original = admission.kind === 'duplicate' ? admission.original : admission;
  return original.kind === 'rejected'
    ? { delivery: 'rejected', reason: original.reason, ...(replayed ? { replayed: true } : {}) }
    : { delivery: original.kind, messageId: original.messageId, ...(replayed ? { replayed: true } : {}) };
}

/** No inferred final text, synthetic cancellation or turn ownership. */
export function submissionOutcome(record: WireSubmissionRecord, state: WireSnapshot): BridgeOutcome {
  if (record.stage === 'retracted' || record.stage === 'discarded' || record.stage === 'cancelled') {
    return { state: 'interrupted' };
  }
  const terminal = state.terminal?.turnId === record.turnId ? state.terminal : undefined;
  const outcome = record.outcome ?? terminal?.outcome;
  if (outcome && outcome !== 'completed') return { state: 'interrupted' };
  if (outcome === 'completed') {
    return record.finalText === null ? { state: 'pending' } : { state: 'final', text: record.finalText };
  }
  if (
    record.turnId &&
    (state.pendingInteractions.some((item) => item.turnId === record.turnId) ||
      state.pendingBudgets?.some((item) => item.turnId === record.turnId))
  ) {
    return { state: 'awaiting_approval' };
  }
  return { state: 'pending' };
}

/** Recover bridge_result from real accepted state, not a transport cache or resubmission. */
export function bridgeSubmissionResult(state: WireSnapshot, requestId: string): ControlBridgeResult {
  const record = state.submissions?.find(
    (item) => item.clientRequestId === requestId && item.origin?.kind === 'discord',
  );
  if (!record) return { state: 'missing' };
  return { ...submissionOutcome(record, state), receipt: { ...admissionReceipt(record.admission), replayed: true } };
}
