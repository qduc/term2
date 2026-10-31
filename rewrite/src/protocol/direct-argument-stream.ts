/** Actual live provider argument progress; no parsed-call, history or replay fallback. */
import type { DirectArgumentStream, DirectBranchTransient } from '../session/facade-types.js';
import type { WireEvent } from './direct-wire.js';

/** Preserve actual producing turn/model step and optional provider evidence.
 * Branch ancestry comes only from the native branch publisher; every frame is
 * transient (null seq), and no finalized tool/execution/message is constructed.
 */
export function argumentStreamEvent(sessionId: string, event: DirectArgumentStream | DirectBranchTransient): WireEvent {
  const child: Extract<WireEvent, { readonly type: 'tool_call_streaming_delta' }> = {
    sessionId, seq: null, occurredAt: null, turnId: event.turnId,
    type: 'tool_call_streaming_delta', payload: {
      modelStep: event.modelStep, argumentCharCount: event.argumentCharCount,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
      ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
      ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
    },
  };
  return 'branchId' in event ? {
    sessionId, seq: null, occurredAt: null, turnId: event.parentTurnId,
    type: 'subagent', payload: {
      agentId: event.taskId, branchId: event.branchId,
      parentTurnId: event.parentTurnId, rootTurnId: event.rootTurnId, event: child,
    },
  } : child;
}
