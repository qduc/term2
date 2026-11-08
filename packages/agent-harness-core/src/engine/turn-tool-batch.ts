/** Legacy's approval batch for one model response's root calls. */
import type { ApprovalRequirement, InteractionDecision, ToolInteractionRequest } from '../tools/contracts.js';

export type BatchPlan = {
  readonly approval?: ApprovalRequirement;
  readonly result?: unknown;
  /** The decision the batch applied to this call. */
  decision?: InteractionDecision;
};

/**
 * Legacy asks every staged call (questions, prompts, policy approvals) in
 * order, but applies only the last decision of each pass; the rest are asked
 * again on the next pass. Calls run in order up to the first undecided one.
 * Returns true when the pass that emptied the batch held a stop decision (an
 * Escaped question): the turn then ends once everything has settled.
 */
export async function runApprovalBatch<Plan extends BatchPlan>(
  plans: readonly Plan[],
  decide: (plan: Plan) => Promise<InteractionDecision>,
  settleBefore: (limit: number) => Promise<void>,
): Promise<boolean> {
  const pending = plans.filter(staged);
  const settle = () => settleBefore(pending.length ? plans.indexOf(pending[0]!) : plans.length);
  await settle();
  let stopped = false;
  while (pending.length > 0) {
    let decision: InteractionDecision = { kind: 'allow' };
    let stop = false;
    for (const plan of pending) {
      decision = await decide(plan);
      if (decision.stopAfterApprovalResolution || (plan.approval?.kind === 'question' && decision.kind === 'deny'))
        stop = true;
    }
    pending.pop()!.decision = decision;
    await settle();
    stopped = stop && pending.length === 0;
  }
  return stopped;
}

/** The interaction a staged call asks, or undefined for legacy's silent policy approval. */
export function batchRequest(
  approval: ApprovalRequirement | undefined,
  call: { readonly toolName: string; readonly input: unknown; readonly callId: string },
): ToolInteractionRequest | undefined {
  if (approval?.kind === 'question') return approval.request;
  if (approval?.kind !== 'ask') return undefined;
  return {
    kind: 'approval',
    toolName: call.toolName,
    input: call.input,
    sourceCallId: call.callId,
    summary: approval.summary,
    ...(approval.detail !== undefined ? { detail: approval.detail } : {}),
    ...(approval.risk !== undefined ? { risk: approval.risk } : {}),
    ...(approval.grants?.length ? { grants: approval.grants } : {}),
  };
}

/** Policy-approved calls legacy stages still run alone, never in a parallel group. */
export function batched(approval: ApprovalRequirement | undefined): boolean {
  return approval?.kind === 'none' && approval.batched === true;
}

/** Calls legacy places in its approval batch: questions, prompts and policy-approved calls. */
function staged(plan: BatchPlan): boolean {
  const approval = plan.approval;
  return !plan.result && (approval?.kind === 'question' || approval?.kind === 'ask' || batched(approval));
}
