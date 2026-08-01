type ApprovalContext = {
  approveTool(item: unknown, options?: { alwaysApprove?: boolean }): void;
  rejectTool(item: unknown, options?: { alwaysReject?: boolean; message?: string }): void;
};

/**
 * One entry of `RunContext.toJSON().approvals`.
 *
 * The upstream runtime does not export this shape, so we restate it here.
 * export the type, so we restate it. The semantics, verified against
 * `runContext.js#isToolApproved`, are:
 *
 * - the record is keyed by **tool name**, not by call id;
 * - `approved: true` / `rejected: true` are *blanket* decisions covering every call of that
 *   tool, including calls the user has never seen;
 * - `approved: string[]` / `rejected: string[]` are decisions scoped to exactly those call
 *   ids, and any other call id still prompts;
 * - `false` carries no decision at all — it is what a blanket decision on the other side
 *   leaves behind;
 * - a blanket approval outranks a blanket rejection.
 */
export type ApprovalRecord = {
  approved: boolean | string[];
  rejected: boolean | string[];
  messages?: Record<string, string>;
  stickyRejectMessage?: string;
};

/**
 * Call id attached to a replayed blanket decision. A blanket decision belongs to the tool
 * rather than to any one call, but `approveTool`/`rejectTool` only accept a call. This
 * sentinel keeps the synthetic call from colliding with a real one, so a blanket rejection's
 * message is always served from `stickyRejectMessage` as it was in the source context.
 */
const BLANKET_DECISION_CALL_ID = '__approval_replay_blanket_decision__';

function buildApprovalItem(toolName: string, callId: string, agent: unknown): unknown {
  return {
    rawItem: { type: 'function_call', callId, name: toolName, arguments: '{}', status: 'completed' },
    agent,
    toolName,
  };
}

/**
 * Seeds `target` with approval decisions already taken elsewhere — in practice, replaying a
 * parent run's approvals into a freshly created nested subagent context so that a tool the
 * user already approved does not prompt a second time inside the subagent.
 *
 * Uses only the public `approveTool` / `rejectTool` surface. `approvals` is the plain
 * `toJSON().approvals` record of the source context.
 *
 * Rejections are replayed before approvals. `approveTool(…, { alwaysApprove: true })` clears
 * the record's rejected list and `rejectTool(…, { alwaysReject: true })` clears its approved
 * list, so ordering decides which survives a record holding both. Rejections-first lands on
 * the same answer `isToolApproved` would have given for the original record, in which a
 * blanket approval outranks everything.
 *
 * Known fidelity limit: a record that is blanket-rejected *and* carries per-call rejection
 * messages keeps only `stickyRejectMessage`. The public API cannot express both, and the
 * difference is confined to message text — every such call is rejected either way.
 */
export function replayApprovals(
  target: ApprovalContext,
  approvals: Readonly<Record<string, ApprovalRecord>> | undefined,
  agent: unknown,
): void {
  if (!approvals) return;

  for (const [toolName, record] of Object.entries(approvals)) {
    if (!record) continue;

    if (record.rejected === true) {
      target.rejectTool(buildApprovalItem(toolName, BLANKET_DECISION_CALL_ID, agent), {
        alwaysReject: true,
        message: record.stickyRejectMessage,
      });
    } else if (Array.isArray(record.rejected)) {
      for (const callId of record.rejected) {
        target.rejectTool(buildApprovalItem(toolName, callId, agent), {
          message: record.messages?.[callId],
        });
      }
    }

    if (record.approved === true) {
      target.approveTool(buildApprovalItem(toolName, BLANKET_DECISION_CALL_ID, agent), {
        alwaysApprove: true,
      });
    } else if (Array.isArray(record.approved)) {
      for (const callId of record.approved) {
        target.approveTool(buildApprovalItem(toolName, callId, agent));
      }
    }
  }
}
