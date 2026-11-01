/** Server-owned agent-wire v2 envelope adaptation. The shared v2 parser/artifact is not
 * bundled yet; these structural types mirror the authoritative source contract pending that
 * artifact. One accepted envelope is one real FactLine boundary and one SSE cursor.
 */
import type { AgentEventType } from '@qduc/agent-wire';
import type {
  WireCommandReceipt,
  WireCommandResult,
  WireConfiguration,
  WireEvent,
  WireModel,
} from '../protocol/direct-wire.js';
import type { ServerInteractions } from './server-interactions.js';
import {
  canonicalCandidate,
  canonicalCommandMessageCandidates,
  type CanonicalEventContext,
} from './server-events.js';
import { ServerHttpError } from './server-errors.js';

/** Explicit v2 negotiation is implemented, but activation waits for the shared artifact and
 * browser/BFF migration. Do not flip this to claim support from the pinned v1 package. */
export const AGENT_WIRE_V2_RUNTIME_AVAILABLE: boolean = false;

export type AgentWireV2ChangeType =
  | AgentEventType
  | 'queue_changed'
  | 'session_rotated'
  | 'reasoning'
  | 'tool_progress'
  | 'task_progress'
  | 'automatic_memory_notice'
  | 'command_started'
  | 'command_finished'
  | 'history_replaced'
  | 'configuration';

/** Must match the shared source's v2 live allowlist. A live batch cannot carry durable state. */
const LIVE_CHANGE_TYPES = new Set<AgentWireV2ChangeType>([
  'reasoning_delta',
  'tool_progress',
  'tool_call_streaming_delta',
  'task_progress',
  'automatic_memory_notice',
  'retry',
  'retry_exhausted',
]);

export type AgentWireV2Branch = {
  readonly branchId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
};

export type AgentWireV2Change = {
  readonly type: AgentWireV2ChangeType;
  /** Native/public payload. The shared parser owns final structural validation. */
  readonly payload: unknown;
  readonly branch?: AgentWireV2Branch;
};

export type AgentWireV2Accepted = {
  readonly schemaVersion: 2;
  readonly kind: 'accepted';
  readonly sessionId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly changes: readonly AgentWireV2Change[];
};

export type AgentWireV2Live = {
  readonly schemaVersion: 2;
  readonly kind: 'live';
  readonly sessionId: string;
  readonly changes: readonly AgentWireV2Change[];
};

export type AgentWireV2Envelope = AgentWireV2Accepted | AgentWireV2Live;

type AgentReasoningV2 = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type AgentConfigurationV2 = { readonly model: WireModel; readonly reasoning?: AgentReasoningV2; readonly temperature?: number };
type AgentConfigureSelectionV2 = {
  readonly model?: WireModel;
  readonly reasoning?: 'default' | AgentReasoningV2;
  readonly temperature?: number;
  readonly profileId?: string;
};
type AgentConfigureOutcomeV2 =
  | { readonly kind: 'configured'; readonly configuration: AgentConfigurationV2 }
  | { readonly kind: 'rejected'; readonly code: 'ineligible' | 'stale' | 'busy' | 'unavailable' | 'cancelled' | 'failed'; readonly message: string }
  | { readonly kind: 'interrupted'; readonly reason: 'outcome_unobserved' };
type AgentConfigureReceiptV2 = {
  readonly request: {
    readonly commandId: string;
    readonly operation: { readonly kind: 'configure'; readonly configuration: AgentConfigureSelectionV2 };
    readonly admission?: 'idle';
    readonly expectedRevision?: string;
  };
  readonly revision: string;
  readonly outcome?: AgentConfigureOutcomeV2;
};
type ConfigureNonReceiptCode =
  | 'invalid_command' | 'unavailable' | 'stale_interaction' | 'request_conflict' | 'rejected'
  | 'closed' | 'not_found' | 'forbidden' | 'storage_failure' | 'too_late'
  | 'internal_error' | 'replay_unavailable' | 'not_admitting';
export type AgentConfigureCommandResultV2 =
  | { readonly ok: true; readonly kind: 'command_pending'; readonly replayed?: boolean; readonly receipt: AgentConfigureReceiptV2 & { readonly outcome?: never } }
  | { readonly ok: true; readonly kind: 'command_finished'; readonly replayed?: boolean; readonly receipt: AgentConfigureReceiptV2 & { readonly outcome: Extract<AgentConfigureOutcomeV2, { kind: 'configured' }> } }
  | { readonly ok: false; readonly code: 'command_rejected'; readonly replayed?: boolean; readonly commandId: string; readonly message: string; readonly receipt: AgentConfigureReceiptV2 & { readonly outcome: Extract<AgentConfigureOutcomeV2, { kind: 'rejected' }> } }
  | { readonly ok: false; readonly code: 'command_interrupted'; readonly replayed?: boolean; readonly commandId: string; readonly message: string; readonly receipt: AgentConfigureReceiptV2 & { readonly outcome: Extract<AgentConfigureOutcomeV2, { kind: 'interrupted' }> } }
  | { readonly ok: false; readonly code: ConfigureNonReceiptCode; readonly message: string; readonly commandId?: string };

export type AgentConfigureResultV2 = {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly result: AgentConfigureCommandResultV2;
};

/** Project one public event. Accepted boundaries always carry their original seq/at; live-only
 * events never acquire a synthetic cursor. Non-public snapshot/state updates do not emit frames. */
export function encodeAgentWireV2(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext = {},
): AgentWireV2Envelope | null {
  if (event.type === 'snapshot') return null;
  const changes = changesFor(event, interactions, context);
  if (event.seq === null) {
    const live = changes.filter(change => LIVE_CHANGE_TYPES.has(change.type));
    return live.length ? { schemaVersion: 2, kind: 'live', sessionId: event.sessionId, changes: live } : null;
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1)
    return unavailable('accepted v2 event has no positive safe cursor');
  if (!event.sessionId) return unavailable('accepted v2 event has no session identity');
  if (!event.occurredAt || /[\u0000-\u001f\u007f]/u.test(event.occurredAt))
    return unavailable('accepted v2 event has no original timestamp');
  return {
    schemaVersion: 2,
    kind: 'accepted',
    sessionId: event.sessionId,
    seq: event.seq,
    occurredAt: event.occurredAt,
    changes,
  };
}

/** Convert a native configure result into the exact shared v2 response shape. The conversion
 * fails closed rather than fabricating a receipt or accepting a different native outcome. */
export function encodeAgentConfigureResultV2(
  sessionId: string,
  result: WireCommandResult,
): AgentConfigureResultV2 {
  if (!sessionId) return unavailable('configure result has no session identity');
  return { schemaVersion: 2, sessionId, result: configureResult(result) };
}

function changesFor(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
  branch?: AgentWireV2Branch,
): AgentWireV2Change[] {
  if (event.type === 'snapshot') return [];
  if (event.type === 'subagent') return subagentChanges(event, interactions, context);
  const exact = exactChange(event, branch);
  if (exact) return [exact];
  if (event.type === 'tool_finished') {
    const candidates = canonicalCommandMessageCandidates(event);
    if (candidates.length) return candidates.map(candidate => change(candidate, branch));
  }
  const candidate = canonicalCandidate(event, interactions, context);
  return candidate ? [change(candidate, branch)] : [];
}

function subagentChanges(
  event: Extract<WireEvent, { type: 'subagent' }>,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): AgentWireV2Change[] {
  const { branchId, turnId, agentId, parentTurnId, rootTurnId } = event.payload;
  if (!branchId || !turnId)
    return unavailable('branch v2 change requires accepted branch and turn identity');
  const branch: AgentWireV2Branch = {
    branchId,
    taskId: agentId,
    turnId,
    ...(parentTurnId !== undefined ? { parentTurnId } : {}),
    ...(rootTurnId !== undefined ? { rootTurnId } : {}),
  };
  return changesFor(event.payload.event, interactions, context, branch);
}

function exactChange(event: WireEvent, branch?: AgentWireV2Branch): AgentWireV2Change | null {
  switch (event.type) {
    case 'queue_changed':
      return change({ type: 'queue_changed', payload: event.payload }, branch);
    case 'session_rotated':
      if (event.payload.logicalSessionId !== event.sessionId)
        return unavailable('rotation logical session does not match envelope identity');
      // Shared v2 permits rotation only as a root change.
      if (branch) return unavailable('rotation cannot be branch-scoped');
      return change({ type: 'session_rotated', payload: event.payload });
    case 'compaction_started':
      return change({
        type: 'context_compaction_started',
        payload: { turnId: scopedTurn(event, branch), ...event.payload },
      }, branch);
    case 'compaction_completed':
      return change({
        type: 'context_compaction_completed',
        payload: { turnId: scopedTurn(event, branch), ...event.payload },
      }, branch);
    case 'compaction_failed':
      return change({
        type: 'context_compaction_failed',
        payload: { turnId: scopedTurn(event, branch), ...event.payload },
      }, branch);
    case 'history_replaced': {
      const turnId = scopedTurnIfPresent(event, branch);
      if (event.payload.compactionId !== undefined && turnId === undefined)
        return unavailable('compaction history replacement requires its accepted turn identity');
      return change({
        type: 'history_replaced',
        payload: { ...(turnId ? { turnId } : {}), ...event.payload },
      }, branch);
    }
    case 'configuration':
      return change({ type: 'configuration', payload: event.payload }, branch);
    case 'command_started':
    case 'command_finished':
      return change({ type: event.type, payload: event.payload }, branch);
    case 'reasoning':
      return change({ type: 'reasoning', payload: event.payload }, branch);
    case 'tool_progress':
      return change({ type: 'tool_progress', payload: event.payload }, branch);
    case 'tool_call_streaming_delta':
      return change({ type: 'tool_call_streaming_delta', payload: event.payload }, branch);
    case 'task_progress':
      return change({ type: 'task_progress', payload: event.payload }, branch);
    case 'automatic_memory_notice':
      return change({ type: 'automatic_memory_notice', payload: event.payload }, branch);
    case 'compacted':
      // Presentation notice only; lifecycle facts are the context_compaction_* changes.
      return null;
    default:
      return null;
  }
}

function change(candidate: { readonly type: AgentWireV2ChangeType; readonly payload: unknown }, branch?: AgentWireV2Branch): AgentWireV2Change {
  return {
    type: candidate.type,
    payload: candidate.payload,
    ...(branch ? { branch } : {}),
  };
}

function requiredTurn(event: WireEvent): string {
  if (!event.turnId) return unavailable('v2 lifecycle change requires its accepted turn identity');
  return event.turnId;
}

function scopedTurn(event: WireEvent, branch?: AgentWireV2Branch): string {
  const turnId = requiredTurn(event);
  if (branch && branch.turnId !== turnId)
    return unavailable('lifecycle turn does not match its accepted branch scope');
  return turnId;
}

function scopedTurnIfPresent(event: WireEvent, branch?: AgentWireV2Branch): string | undefined {
  if (event.turnId === null) return undefined;
  if (branch && branch.turnId !== event.turnId)
    return unavailable('history turn does not match its accepted branch scope');
  return event.turnId;
}

function configureResult(result: WireCommandResult): AgentConfigureCommandResultV2 {
  if (result.ok) {
    if (result.kind === 'command_pending') {
      if (result.receipt.outcome !== undefined)
        return unavailable('pending configure result must not have an outcome');
      return {
        ok: true,
        kind: 'command_pending',
        ...(typeof result.replayed === 'boolean' ? { replayed: result.replayed } : {}),
        receipt: configureReceiptBase(result.receipt),
      };
    }
    if (result.kind === 'command_finished') {
      if (result.receipt.outcome?.kind !== 'configured')
        return unavailable('finished configure result requires a configured outcome');
      return {
        ok: true,
        kind: 'command_finished',
        ...(typeof result.replayed === 'boolean' ? { replayed: result.replayed } : {}),
        receipt: { ...configureReceiptBase(result.receipt), outcome: configuredOutcome(result.receipt.outcome.configuration) },
      };
    }
    return unavailable('configure result is not a native command receipt');
  }
  if (result.code === 'command_rejected' || result.code === 'command_interrupted') {
    if (result.receipt.request.commandId !== result.commandId)
      return unavailable('configure result command identity does not match its receipt');
    if (result.code === 'command_rejected') {
      if (result.receipt.outcome?.kind !== 'rejected')
        return unavailable('rejected configure result has the wrong outcome');
      return {
        ok: false,
        code: 'command_rejected',
        ...(typeof result.replayed === 'boolean' ? { replayed: result.replayed } : {}),
        commandId: result.commandId,
        message: result.message,
        receipt: { ...configureReceiptBase(result.receipt), outcome: {
          kind: 'rejected', code: result.receipt.outcome.code, message: result.receipt.outcome.message,
        } },
      };
    }
    if (result.receipt.outcome?.kind !== 'interrupted')
      return unavailable('interrupted configure result has the wrong outcome');
    return {
      ok: false,
      code: 'command_interrupted',
      ...(typeof result.replayed === 'boolean' ? { replayed: result.replayed } : {}),
      commandId: result.commandId,
      message: result.message,
      receipt: { ...configureReceiptBase(result.receipt), outcome: { kind: 'interrupted', reason: result.receipt.outcome.reason } },
    };
  }
  if (!isConfigureNonReceiptCode(result.code))
    return unavailable('configure failure is not a versioned native command result');
  return {
    ok: false,
    code: result.code,
    message: result.message,
    ...(result.commandId !== undefined ? { commandId: result.commandId } : {}),
  };
}

function configureReceiptBase(receipt: WireCommandReceipt): Omit<AgentConfigureReceiptV2, 'outcome'> {
  const request = receipt.request;
  if (request.operation.kind !== 'configure')
    return unavailable('configure receipt has a different native operation');
  return {
    request: {
      commandId: request.commandId,
      operation: { kind: 'configure', configuration: configureSelection(request.operation.configuration) },
      ...(request.admission !== undefined ? { admission: request.admission } : {}),
      ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
    },
    revision: receipt.revision,
  };
}

function configuredOutcome(configuration: WireConfiguration & { readonly model: WireModel }): Extract<AgentConfigureOutcomeV2, { kind: 'configured' }> {
  return { kind: 'configured', configuration: {
    model: { ...configuration.model },
    ...(configuration.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
    ...(configuration.temperature !== undefined ? { temperature: configuration.temperature } : {}),
  } };
}

const NON_RECEIPT_CODES = new Set([
  'invalid_command', 'unavailable', 'stale_interaction', 'request_conflict', 'rejected', 'closed',
  'not_found', 'forbidden', 'storage_failure', 'too_late', 'internal_error', 'replay_unavailable',
  'not_admitting',
]);
function isConfigureNonReceiptCode(value: string): value is ConfigureNonReceiptCode {
  return NON_RECEIPT_CODES.has(value);
}

function unavailable(message: string): never {
  throw new ServerHttpError(503, 'event_envelope_v2_unavailable', message, true, {
    reloadRequired: true,
    requiredFormat: 'agent-wire-v2',
  });
}
