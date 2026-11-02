/** Server-owned agent-wire v2 envelope adaptation. This source imports the exact
 * shared v2 exports from the pinned 0.2.0 artifact, which provides them and is what compiles here.
 * Runtime activation is still gated off by AGENT_WIRE_V2_RUNTIME_AVAILABLE below.
 * One accepted envelope is one real FactLine boundary and one SSE cursor.
 */
import type {
  AgentAcceptedChangeTypeV2,
  AgentAcceptedEnvelopeV2,
  AgentBranchV2,
  AgentChangeTypeV2,
  AgentConfigurationV2,
  AgentConfigureCommandResultV2,
  AgentConfigureOutcomeV2,
  AgentConfigureReceiptV2,
  AgentConfigureResultV2,
  AgentConfigureSelectionV2,
  AgentEventEnvelopeV2,
  AgentLiveChangeTypeV2,
  AgentLiveEnvelopeV2,
  AgentReasoningV2,
} from '@qduc/agent-wire';
import { AGENT_CHANGE_TYPES_V2, AGENT_LIVE_CHANGE_TYPES_V2 } from '@qduc/agent-wire';
import type {
  WireCommandReceipt,
  WireCommandResult,
  WireConfigureRequest,
  WireConfiguration,
  WireEvent,
  WireModel,
} from '../protocol/direct-wire.js';
import type { ServerInteractions } from './server-interactions.js';
import { canonicalCandidate, canonicalCommandMessageCandidates, type CanonicalEventContext } from './server-events.js';
import { ServerHttpError } from './server-errors.js';

/** Explicit v2 negotiation is implemented against the pinned 0.2.0 artifact, but activation
 * (this flag) waits for the browser/BFF migration. Do not flip it to claim support before then. */
export const AGENT_WIRE_V2_RUNTIME_AVAILABLE: boolean = false;

/** Public aliases to the exact shared v2 exports. No local vocabulary copy. */
export type AgentWireV2ChangeType = AgentChangeTypeV2;
export type AgentWireV2Branch = AgentBranchV2;
export type AgentWireV2AcceptedChangeType = AgentAcceptedChangeTypeV2;
export type AgentWireV2LiveChangeType = AgentLiveChangeTypeV2;
export type AgentWireV2AcceptedChange = AgentAcceptedEnvelopeV2['changes'][number];
export type AgentWireV2LiveChange = AgentLiveEnvelopeV2['changes'][number];
export type AgentWireV2Accepted = AgentAcceptedEnvelopeV2;
export type AgentWireV2Live = AgentLiveEnvelopeV2;
export type AgentWireV2Envelope = AgentEventEnvelopeV2;
export type { AgentConfigureCommandResultV2, AgentConfigureResultV2 } from '@qduc/agent-wire';

/** Internal unvalidated projection draft. The shared exports above own the
 * accepted/live vocabulary; the shared parser owns payload validation. */
type AgentWireV2ChangeDraft = {
  readonly type: AgentChangeTypeV2;
  readonly payload: unknown;
  readonly branch?: AgentBranchV2;
};

/** Exact shared runtime allowlists. Accepted and live are intentionally separate:
 * accepted envelopes never contain `error`; live envelopes may contain error and
 * the synchronized `turn_failed` companion. */
const ACCEPTED_CHANGE_TYPES = new Set<string>(AGENT_CHANGE_TYPES_V2);
const LIVE_CHANGE_TYPES = new Set<string>(AGENT_LIVE_CHANGE_TYPES_V2);

type ConfigureNonReceiptCode =
  | 'invalid_command'
  | 'unavailable'
  | 'stale_interaction'
  | 'request_conflict'
  | 'rejected'
  | 'closed'
  | 'not_found'
  | 'forbidden'
  | 'storage_failure'
  | 'too_late'
  | 'internal_error'
  | 'replay_unavailable'
  | 'not_admitting';

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
    const live = changes.filter(isLiveChange);
    return live.length ? { schemaVersion: 2, kind: 'live', sessionId: event.sessionId, changes: live } : null;
  }
  // Native runtime errors are synchronized state observations, never accepted
  // facts. Refuse to turn one into a synthetic durable boundary.
  if (event.type === 'error') return unavailable('runtime error is live-only and cannot be accepted');
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
    changes: changes.filter(isAcceptedChange),
  };
}

function isLiveChange(change: AgentWireV2ChangeDraft): change is AgentWireV2LiveChange {
  return LIVE_CHANGE_TYPES.has(change.type);
}

function isAcceptedChange(change: AgentWireV2ChangeDraft): change is AgentWireV2AcceptedChange {
  return ACCEPTED_CHANGE_TYPES.has(change.type);
}

/** Convert a native configure result into the exact shared v2 response shape. The conversion
 * fails closed rather than fabricating a receipt or accepting a different native outcome. */
export function encodeAgentConfigureResultV2(sessionId: string, result: WireCommandResult): AgentConfigureResultV2 {
  if (!sessionId) return unavailable('configure result has no session identity');
  return { schemaVersion: 2, sessionId, result: configureResult(result) };
}

function changesFor(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
  branch?: AgentWireV2Branch,
): AgentWireV2ChangeDraft[] {
  if (event.type === 'snapshot') return [];
  if (event.type === 'subagent') return subagentChanges(event, interactions, context);
  const exact = exactChange(event, branch);
  if (exact) return [exact];
  if (event.type === 'tool_finished') {
    const candidates = canonicalCommandMessageCandidates(event);
    if (candidates.length) return candidates.map((candidate) => change(candidate, branch));
  }
  const candidate = canonicalCandidate(event, interactions, context);
  return candidate ? [change(candidate, branch)] : [];
}

function subagentChanges(
  event: Extract<WireEvent, { type: 'subagent' }>,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): AgentWireV2ChangeDraft[] {
  const { branchId, turnId, agentId, parentTurnId, rootTurnId } = event.payload;
  if (!branchId || !turnId) return unavailable('branch v2 change requires accepted branch and turn identity');
  const branch: AgentWireV2Branch = {
    branchId,
    taskId: agentId,
    turnId,
    ...(parentTurnId !== undefined ? { parentTurnId } : {}),
    ...(rootTurnId !== undefined ? { rootTurnId } : {}),
  };
  return changesFor(event.payload.event, interactions, context, branch);
}

function exactChange(event: WireEvent, branch?: AgentWireV2Branch): AgentWireV2ChangeDraft | null {
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
      return change(
        {
          type: 'context_compaction_started',
          payload: { turnId: scopedTurn(event, branch), ...event.payload },
        },
        branch,
      );
    case 'compaction_completed':
      return change(
        {
          type: 'context_compaction_completed',
          payload: { turnId: scopedTurn(event, branch), ...event.payload },
        },
        branch,
      );
    case 'compaction_failed':
      return change(
        {
          type: 'context_compaction_failed',
          payload: { turnId: scopedTurn(event, branch), ...event.payload },
        },
        branch,
      );
    case 'history_replaced': {
      const turnId = scopedTurnIfPresent(event, branch);
      if (event.payload.compactionId !== undefined && turnId === undefined)
        return unavailable('compaction history replacement requires its accepted turn identity');
      return change(
        {
          type: 'history_replaced',
          payload: { ...(turnId ? { turnId } : {}), ...event.payload },
        },
        branch,
      );
    }
    case 'configuration':
      return change({ type: 'configuration', payload: event.payload }, branch);
    // Accepted native evidence additions. Cost is aggregate state, not an
    // increment; request records retain their own physical identity/ancestry.
    case 'cost':
      return change({ type: 'cost', payload: event.payload });
    case 'request_cost_recorded':
      // The payload already owns turn/root/parent ancestry. Do not add a second
      // branch wrapper or treat it as another charge.
      return change({ type: 'request_cost_recorded', payload: event.payload });
    case 'goal':
      return change({ type: 'goal', payload: event.payload }, branch);
    case 'goal_proposed':
      return change({ type: 'goal_proposed', payload: event.payload }, branch);
    case 'verification':
      return change({ type: 'verification', payload: event.payload }, branch);
    case 'notice':
      return change({ type: 'notice', payload: event.payload }, branch);
    case 'background_notice_enqueued':
      return change({ type: 'background_notice_enqueued', payload: event.payload }, branch);
    case 'background_notices_delivered':
      return change({ type: 'background_notices_delivered', payload: event.payload }, branch);
    case 'command_started':
    case 'command_finished':
      return change({ type: event.type, payload: event.payload }, branch);
    case 'reasoning':
      return change({ type: 'reasoning', payload: event.payload }, branch);
    // Accepted transcript/task updates have real native producers but no shared
    // v2 names yet. Preserve their exact public payload; do not relabel them as
    // terminals or synthesize missing fields. Shared v2 parser/consumer intake
    // is a separate owner dependency (see m6-v2-remaining-vocabulary-final.md).
    case 'message':
      return change({ type: 'message', payload: event.payload }, branch);
    case 'task_changed':
      // Shared v2 task descriptors are root metadata; a branch wrapper is invalid.
      if (branch) return unavailable('task_changed is root task metadata');
      return change({ type: 'task_changed', payload: event.payload });
    case 'tool_called':
      return change({ type: 'tool_called', payload: event.payload }, branch);
    case 'error':
      return change({ type: 'error', payload: event.payload }, branch);
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

function change(
  candidate: { readonly type: AgentWireV2ChangeType; readonly payload: unknown },
  branch?: AgentWireV2Branch,
): AgentWireV2ChangeDraft {
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
  if (branch && branch.turnId !== turnId) return unavailable('lifecycle turn does not match its accepted branch scope');
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
      if (result.receipt.outcome !== undefined) return unavailable('pending configure result must not have an outcome');
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
        receipt: {
          ...configureReceiptBase(result.receipt),
          outcome: configuredOutcome(result.receipt.outcome.configuration),
        },
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
        receipt: {
          ...configureReceiptBase(result.receipt),
          outcome: {
            kind: 'rejected',
            code: result.receipt.outcome.code,
            message: result.receipt.outcome.message,
          },
        },
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
      receipt: {
        ...configureReceiptBase(result.receipt),
        outcome: { kind: 'interrupted', reason: result.receipt.outcome.reason },
      },
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

/** Exact requested selection; preserve optionality and never synthesize a default. */
function configureSelection(configuration: WireConfigureRequest): AgentConfigureSelectionV2 {
  return {
    ...(configuration.model !== undefined ? { model: { ...configuration.model } } : {}),
    ...(configuration.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
    ...(configuration.temperature !== undefined ? { temperature: configuration.temperature } : {}),
    ...(configuration.profileId !== undefined ? { profileId: configuration.profileId } : {}),
  };
}
function configureReceiptBase(receipt: WireCommandReceipt): Omit<AgentConfigureReceiptV2, 'outcome'> {
  const request = receipt.request;
  if (request.operation.kind !== 'configure') return unavailable('configure receipt has a different native operation');
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

function configuredOutcome(
  configuration: WireConfiguration & { readonly model: WireModel },
): Extract<AgentConfigureOutcomeV2, { kind: 'configured' }> {
  return {
    kind: 'configured',
    configuration: {
      model: { ...configuration.model },
      ...(configuration.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
      ...(configuration.temperature !== undefined ? { temperature: configuration.temperature } : {}),
    },
  };
}

const NON_RECEIPT_CODES = new Set([
  'invalid_command',
  'unavailable',
  'stale_interaction',
  'request_conflict',
  'rejected',
  'closed',
  'not_found',
  'forbidden',
  'storage_failure',
  'too_late',
  'internal_error',
  'replay_unavailable',
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
