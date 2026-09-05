import { isDeepStrictEqual } from 'node:util';
import type {
  NestedApprovalDecision,
  NestedApprovalDecisionResult,
  NestedApprovalSnapshot,
} from '../../source/services/approval/nested-approval-owner.js';
import { RUN_CODE_PROHIBITED_TOOLS } from '../../source/tools/system/run-code/run-code.js';

/** The public nested-approval surface used by a host of a real session. */
export type NestedApprovalDecisionPort = {
  getSnapshot: () => NestedApprovalSnapshot | null;
  subscribe: (observer: ((snapshot: NestedApprovalSnapshot | null) => void) | null) => () => void;
  decide: (requestId: string, decision: NestedApprovalDecision) => Promise<NestedApprovalDecisionResult>;
};

/** One exact, deterministic answer in a test or benchmark script. */
export type ScriptedNestedApprovalCall = {
  sessionId: string;
  toolName: string;
  preparedArguments: unknown;
  answer: string;
  rejectionReason?: string;
  outerRunId?: string;
  nestedCallId?: string;
  requestId?: string;
};

export type ScriptedNestedApprovalAdapterOptions = {
  responder?: (
    snapshot: NestedApprovalSnapshot,
    expected: ScriptedNestedApprovalCall,
  ) => NestedApprovalDecision | Promise<NestedApprovalDecision>;
  onRequest?: (snapshot: NestedApprovalSnapshot, expected: ScriptedNestedApprovalCall | undefined) => void;
};

export type ScriptedNestedApprovalAdapter = {
  dispose: () => void;
};

const denial: NestedApprovalDecision = { answer: 'n', rejectionReason: 'Scripted nested approval denied.' };

function hasOrdinaryNestedIdentity(snapshot: NestedApprovalSnapshot): boolean {
  return (
    snapshot.approval.agentName === 'Nested run_code' &&
    snapshot.approval.rawInterruption === null &&
    snapshot.approval.toolName === snapshot.toolName &&
    !RUN_CODE_PROHIBITED_TOOLS.has(snapshot.toolName) &&
    snapshot.approval.callId === snapshot.nestedCallId &&
    snapshot.approval.dockerHostControl !== true &&
    snapshot.approval.deniedRead === undefined &&
    snapshot.approval.postExecute === undefined &&
    snapshot.approval.runBudgetEvent === undefined &&
    snapshot.approval.checkIn === undefined &&
    [snapshot.requestId, snapshot.sessionId, snapshot.outerRunId, snapshot.nestedCallId, snapshot.toolName].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  );
}

function matchesExpected(snapshot: NestedApprovalSnapshot, expected: ScriptedNestedApprovalCall): boolean {
  return (
    snapshot.sessionId === expected.sessionId &&
    snapshot.toolName === expected.toolName &&
    isDeepStrictEqual(snapshot.preparedArguments, expected.preparedArguments) &&
    (expected.outerRunId === undefined || snapshot.outerRunId === expected.outerRunId) &&
    (expected.nestedCallId === undefined || snapshot.nestedCallId === expected.nestedCallId) &&
    (expected.requestId === undefined || snapshot.requestId === expected.requestId)
  );
}

/**
 * Installs a fail-closed scripted responder on a session-owned nested owner.
 *
 * This module lives under scripts intentionally: production construction has no
 * option that can select a scripted responder. The owner remains the only
 * authority; this adapter only supplies an answer to its exact request.
 */
export function createScriptedNestedApprovalAdapter(
  port: NestedApprovalDecisionPort,
  expectedCalls: readonly ScriptedNestedApprovalCall[],
  options: ScriptedNestedApprovalAdapterOptions = {},
): ScriptedNestedApprovalAdapter {
  let disposed = false;
  let failed = false;
  let nextExpected = 0;
  const responding = new Set<string>();

  const deny = (requestId: string): void => {
    void port.decide(requestId, denial).catch(() => {
      // The owner may already have closed or consumed this request. Either way
      // the adapter cannot grant it and must remain fail-closed.
    });
  };

  const respond = async (snapshot: NestedApprovalSnapshot): Promise<void> => {
    if (disposed || responding.has(snapshot.requestId)) return;
    responding.add(snapshot.requestId);
    try {
      const expected = expectedCalls[nextExpected];
      let decision: NestedApprovalDecision = denial;
      const matchedExpected =
        !failed && expected && hasOrdinaryNestedIdentity(snapshot) && matchesExpected(snapshot, expected);
      if (matchedExpected) {
        try {
          options.onRequest?.(snapshot, expected);
          decision = options.responder
            ? await options.responder(snapshot, expected)
            : {
                answer: expected.answer,
                ...(expected.rejectionReason ? { rejectionReason: expected.rejectionReason } : {}),
              };
        } catch {
          failed = true;
          decision = denial;
        }
      } else {
        failed = true;
      }

      // Disposal wins over a responder that was still awaiting its answer.
      // Never let a late host callback turn disposal into authority.
      if (disposed) decision = denial;

      const result = await port.decide(snapshot.requestId, decision);
      if (result.kind === 'accepted' && matchedExpected && !failed) nextExpected += 1;
      if (result.kind === 'stale') failed = true;
    } catch {
      failed = true;
      deny(snapshot.requestId);
    } finally {
      responding.delete(snapshot.requestId);
    }
  };

  const unsubscribe = port.subscribe((snapshot) => {
    if (snapshot) void respond(snapshot);
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const snapshot = port.getSnapshot();
      if (snapshot) deny(snapshot.requestId);
      unsubscribe();
    },
  };
}
