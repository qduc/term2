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
  dispose: () => Promise<void>;
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
  let processing: Promise<void> | null = null;
  let drain: Promise<void> | null = null;
  let resolveDrain: (() => void) | null = null;
  let releaseResponder: (() => void) | null = null;
  const disposal = new Promise<void>((resolve) => {
    releaseResponder = resolve;
  });
  const queue: NestedApprovalSnapshot[] = [];
  const queued = new Set<string>();
  const answered = new Set<string>();

  const deny = (requestId: string): void => {
    void port.decide(requestId, denial).catch(() => {
      // The owner may already have closed or consumed this request. Either way
      // the adapter cannot grant it and must remain fail-closed.
    });
  };

  const maybeFinishDrain = (): void => {
    if (!disposed || !resolveDrain || processing || queue.length > 0 || port.getSnapshot() !== null) return;
    const resolve = resolveDrain;
    resolveDrain = null;
    unsubscribe();
    resolve();
  };

  const processQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const snapshot = queue.shift()!;
      queued.delete(snapshot.requestId);
      if (answered.has(snapshot.requestId)) continue;
      answered.add(snapshot.requestId);

      const expected = expectedCalls[nextExpected];
      let decision: NestedApprovalDecision = denial;
      const matchedExpected =
        !disposed && !failed && expected && hasOrdinaryNestedIdentity(snapshot) && matchesExpected(snapshot, expected);
      if (matchedExpected) {
        try {
          options.onRequest?.(snapshot, expected);
          const supplied = options.responder
            ? options.responder(snapshot, expected)
            : {
                answer: expected.answer,
                ...(expected.rejectionReason ? { rejectionReason: expected.rejectionReason } : {}),
              };
          decision = await Promise.race([Promise.resolve(supplied), disposal.then(() => denial)]);
        } catch {
          failed = true;
          decision = denial;
        }
      } else if (!disposed) {
        failed = true;
      }

      // Reserve the expected answer before decide(). The real owner can publish
      // its next synchronous head from inside decide(), before the acknowledgement
      // promise returns. Processing remains serialized, so that publication waits
      // behind this decision and sees the reserved cursor.
      if (matchedExpected && !failed && !disposed) nextExpected += 1;
      if (disposed) decision = denial;

      try {
        const result = await port.decide(snapshot.requestId, decision);
        if (result.kind === 'stale') failed = true;
      } catch {
        failed = true;
        deny(snapshot.requestId);
      }
    }
  };

  const schedule = (): void => {
    if (processing) return;
    processing = processQueue().finally(() => {
      processing = null;
      maybeFinishDrain();
      if (queue.length > 0) schedule();
    });
  };

  const enqueue = (snapshot: NestedApprovalSnapshot | null): void => {
    if (!snapshot) {
      maybeFinishDrain();
      return;
    }
    if (answered.has(snapshot.requestId) || queued.has(snapshot.requestId)) return;
    queued.add(snapshot.requestId);
    queue.push(snapshot);
    schedule();
  };

  const unsubscribe = port.subscribe(enqueue);

  return {
    dispose: async () => {
      if (drain) return drain;
      disposed = true;
      drain = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      releaseResponder?.();
      enqueue(port.getSnapshot());
      schedule();
      maybeFinishDrain();
      return drain;
    },
  };
}
