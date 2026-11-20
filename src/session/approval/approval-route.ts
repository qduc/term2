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

/** Options the route reads from settings besides the mode. */
export type ApprovalRouteOptions = {
  /** `shell.unattendedEscapeReview`: in `unattended`, let the reviewer decide an outside-sandbox escape. */
  readonly reviewEscapes?: boolean;
};

/**
 * Where an open request goes. `review` asks the reviewer first; `ask_user` waits
 * for a person; `refuse` closes it by policy with no model call (`unattended`
 * only). In `auto` and `advisory` a request the reviewer cannot take goes to a
 * person; in `unattended` it is refused, except a question, which is not an
 * authority decision. An outside-sandbox escape is refused in `unattended`
 * unless `reviewEscapes` is set (docs/plans/approvals-and-sandbox/unattended-approval.md, decision 4).
 */
function routeApproval(
  mode: AutoApproveMode | undefined,
  profile: ApprovalProfile,
  options: ApprovalRouteOptions = {},
): 'review' | 'ask_user' | 'refuse' {
  if (mode === 'unattended') {
    if (profile.hardGate === 'question') return 'ask_user';
    if (profile.hardGate || !profile.reviewable) return 'refuse';
    if (profile.autoGrant === 'unsandboxed-once' && options.reviewEscapes !== true) return 'refuse';
    return 'review';
  }
  if (mode !== 'auto' && mode !== 'advisory') return 'ask_user';
  if (profile.hardGate || !profile.reviewable) return 'ask_user';
  return 'review';
}

/**
 * The route with what it means for a surface: `decide` reviews and a pass answers;
 * `advise` reviews only to inform a person; `judge` reviews, a pass answers and
 * anything else is refused (`unattended`); `ask_user` waits for a person; `refuse`
 * closes the request by policy without a review.
 */
export type ApprovalRoute =
  | { readonly kind: 'decide' | 'advise' | 'judge' | 'ask_user' }
  | { readonly kind: 'refuse'; readonly reason: string };

export function approvalRouteFor(
  mode: AutoApproveMode | undefined,
  profile: ApprovalProfile,
  options: ApprovalRouteOptions = {},
): ApprovalRoute {
  const route = routeApproval(mode, profile, options);
  if (route === 'refuse') return { kind: 'refuse', reason: unreviewedRefusalReason(profile) };
  if (route === 'ask_user') return { kind: 'ask_user' };
  return { kind: mode === 'unattended' ? 'judge' : mode === 'auto' ? 'decide' : 'advise' };
}

/** Why `unattended` refuses a request without asking the reviewer. */
function unreviewedRefusalReason(profile: ApprovalProfile): string {
  switch (profile.hardGate) {
    case 'explicit-user':
      return 'this decision requires an explicit answer from the user';
    case 'denied-read':
      return 'it retries a read the sandbox denied, which only the user may grant';
    case 'docker-host':
      return 'it controls the Docker host, which only the user may grant';
    default:
      break;
  }
  if (!profile.reviewable) return 'this tool is not one the approval reviewer may grant';
  return 'it would run outside the sandbox, which unattended mode does not allow';
}

/** The modes in which a passing review answers the request. */
function reviewMayApprove(mode: AutoApproveMode | undefined): boolean {
  return mode === 'auto' || mode === 'unattended';
}

/** The one threshold a review must clear to answer a request without a person. */
function acceptVerdict(advisory: LLMAdvisory | undefined, mode: AutoApproveMode | undefined): boolean {
  return (
    reviewMayApprove(mode) &&
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
  /** Read with the mode, before the review; defaults to none. */
  readonly routeOptions?: () => ApprovalRouteOptions;
  readonly review: () => Promise<LLMAdvisory | undefined>;
  readonly signal: AbortSignal;
}): Promise<ApprovalDecision> {
  const mode = input.currentMode();
  if (input.signal.aborted || routeApproval(mode, input.profile, input.routeOptions?.()) !== 'review')
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
    ...(mode === 'advisory' ? { advisoryOnly: true as const } : {}),
    ...(approved && input.profile.autoGrant ? { grant: input.profile.autoGrant } : {}),
  };
}
