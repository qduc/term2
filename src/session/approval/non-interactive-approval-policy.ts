import type { ApprovalDescriptor } from '../../tools/conversation.js';
import { TOOL_NAME_PROPOSE_GOAL } from '../../tools/tool-names.js';
import { CHECK_IN_TOOL_NAME } from '../../tools/conversation.js';

const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

/** Why a request the approval route left for a person is refused when no person is present. */
const NO_PERSON_REASON = 'No person is available to approve this in a non-interactive run.';

export type NonInteractiveApprovalDecision =
  | { answer: 'y' }
  | {
      answer: 'n';
      rejectionReason: string;
      /** Whether the non-interactive presenter should print the rejection. */
      reportRejection: boolean;
    };

export interface NonInteractiveApprovalPolicyDeps {
  mcpAllowlist?: readonly string[];
  isMcpTool?: (name: string) => boolean;
  isMcpAllowed?: (name: string, allowlist: readonly string[]) => boolean;
}

/**
 * What a headless run does with a request the approval route left for a person
 * (docs/plans/approvals-and-sandbox/headless-approval-redesign.md, decisions 1 and 2).
 * Headless never asks, so such a request is refused with a reason and the model
 * continues. The mode already did all the approving it may do before the request
 * opened: a sandboxed or in-workspace call needed no approval, `auto` let the
 * reviewer pass it, `always` bypassed it. Nothing here runs the shell classifier
 * or a model; the one allowance is an MCP tool the user allowlisted.
 *
 * Before 2026-11-22 this policy approved again on its own: every non-shell tool,
 * and shell commands by classifier and a chore-tier model, including requests
 * the reviewer had rejected. That second approver is gone.
 */
export class NonInteractiveApprovalPolicy {
  constructor(private readonly deps: NonInteractiveApprovalPolicyDeps) {}

  async decide(input: { autoApprove: boolean; approval: ApprovalDescriptor }): Promise<NonInteractiveApprovalDecision> {
    if (!input.autoApprove) {
      return { answer: 'n', rejectionReason: NON_INTERACTIVE_REJECTION_REASON, reportRejection: false };
    }

    const { approval } = input;
    // A run check-in (exhausted budget, stall, max turns) is not a tool: answering
    // it 'y' grants the run more budget or turns, which only a person may do.
    if (approval.checkIn || approval.toolName === CHECK_IN_TOOL_NAME) {
      return {
        answer: 'n',
        rejectionReason: 'Run check-ins need an interactive decision; --auto-approve never grants budget or turns',
        reportRejection: false,
      };
    }
    if (this.deps.isMcpTool?.(approval.toolName) === true) {
      const matches = this.deps.isMcpAllowed?.(approval.toolName, this.deps.mcpAllowlist ?? []) ?? false;
      return matches
        ? { answer: 'y' }
        : { answer: 'n', rejectionReason: NON_INTERACTIVE_REJECTION_REASON, reportRejection: false };
    }
    // propose_goal mutates user-authored durable state.
    if (approval.toolName === TOOL_NAME_PROPOSE_GOAL) {
      return {
        answer: 'n',
        rejectionReason: 'propose_goal requires an interactive user decision and is never auto-approved',
        reportRejection: false,
      };
    }
    // The caller appends the shared review's verdict, when one ran.
    return { answer: 'n', rejectionReason: NO_PERSON_REASON, reportRejection: true };
  }
}
