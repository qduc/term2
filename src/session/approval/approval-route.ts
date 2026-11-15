import type { ApprovalReviewResult } from '../../shared/contracts/approval-review.js';
import type { LLMAdvisory } from '../../tools/conversation.js';
import { isAutoApprovableTool, type AutoApproveMode } from './shell-auto-approval-resolver.js';

/**
 * The single decision table for an open approval request: whether the LLM
 * reviewer looks at it, whether a passing review answers it, and with which
 * grant. Every surface (TUI, ACP, headless) and owner (turn, task, nested
 * run_code) reads it; no caller re-derives eligibility from a tool name.
 * See docs/plans/approvals-and-sandbox/approval-arbiter.md.
 */

/** The fields of an InteractionRequest this table reads. */
export type ApprovalRequestShape = {
  readonly kind: 'approval' | 'question';
  readonly toolName: string;
  readonly input: unknown;
  readonly presentation?: Readonly<Record<string, unknown>>;
  readonly grants?: readonly string[];
};

/** Why a request always needs a person, whatever the mode. */
export type ApprovalHardGate = 'question' | 'explicit-user' | 'denied-read' | 'docker-host';

export type ApprovalProfile = {
  readonly hardGate?: ApprovalHardGate;
  /** The reviewer can describe this request. */
  readonly reviewable: boolean;
  /**
   * The grant a passing review answers with. A request that offers a one-time
   * scoped grant (an outside-sandbox escape, a network destination) is only
   * honoured with that grant; anything else is a plain allow.
   */
  readonly autoGrant?: string;
};

/** One-time grants a request may require in place of a plain allow, in priority order. */
const ONE_TIME_GRANTS = ['unsandboxed-once', 'network-allow-once'] as const;

export function describeApproval(
  request: ApprovalRequestShape,
  context: { readonly isDockerHostControl: (toolName: string, input: unknown) => boolean },
): ApprovalProfile {
  const autoGrant = ONE_TIME_GRANTS.find((grant) => request.grants?.includes(grant));
  const hardGate: ApprovalHardGate | undefined =
    request.kind === 'question'
      ? 'question'
      : request.presentation?.requiresExplicitUser === true
      ? 'explicit-user'
      : request.presentation?.deniedRead
      ? 'denied-read'
      : request.presentation?.dockerHostControl === true ||
        request.grants?.some((grant) => grant.startsWith('docker-')) ||
        context.isDockerHostControl(request.toolName, request.input)
      ? 'docker-host'
      : undefined;
  return {
    ...(hardGate ? { hardGate } : {}),
    reviewable: isAutoApprovableTool(request.toolName),
    ...(autoGrant ? { autoGrant } : {}),
  };
}

/** Review only in `auto` (may answer) and `advisory` (shows the verdict); everything else asks a person. */
export function routeApproval(mode: AutoApproveMode | undefined, profile: ApprovalProfile): 'review' | 'ask_user' {
  if (mode !== 'auto' && mode !== 'advisory') return 'ask_user';
  if (profile.hardGate || !profile.reviewable) return 'ask_user';
  return 'review';
}

/** The one threshold a review must clear to answer a request without a person. */
function acceptVerdict(advisory: LLMAdvisory | undefined, mode: AutoApproveMode | undefined): boolean {
  return (
    mode === 'auto' &&
    advisory !== undefined &&
    !advisory.isError &&
    advisory.approved === true &&
    advisory.source === 'llm' &&
    (advisory.riskLevel === 'low' || advisory.riskLevel === 'medium') &&
    (advisory.authorization === 'explicit' || advisory.authorization === 'implied') &&
    advisory.confidence === 'high'
  );
}

export type ApprovalDecision = ApprovalReviewResult;

/**
 * Route, review and judge one request. `review` performs the model call;
 * `currentMode` is read again after it so a mode change during the review
 * never yields an approval.
 */
export async function decideApproval(input: {
  readonly request: ApprovalRequestShape;
  readonly profile: ApprovalProfile;
  readonly currentMode: () => AutoApproveMode | undefined;
  readonly review: () => Promise<LLMAdvisory | undefined>;
  readonly signal: AbortSignal;
}): Promise<ApprovalDecision> {
  const mode = input.currentMode();
  if (input.signal.aborted || routeApproval(mode, input.profile) !== 'review')
    return { kind: 'not_reviewed', approved: false };
  let advisory: LLMAdvisory | undefined;
  try {
    advisory = await input.review();
  } catch {
    return { kind: 'unavailable', approved: false };
  }
  if (!advisory || advisory.isError) return { kind: 'unavailable', approved: false };
  const approved = !input.signal.aborted && input.currentMode() === mode && acceptVerdict(advisory, mode);
  return {
    kind: 'reviewed',
    approved,
    advisory,
    ...(approved && input.profile.autoGrant ? { grant: input.profile.autoGrant } : {}),
  };
}
