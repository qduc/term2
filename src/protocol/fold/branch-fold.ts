/**
 * Subagent branch state, folded from `subagent` events with the same reducer as the root.
 *
 * A branch is kept as its public `WireBranchSnapshot`. To fold one child event, the branch is put back into a
 * scratch snapshot, reduced, and read out again. The scratch drops root-only state (status, active turn, queue,
 * tasks...); no reducer case a branch receives reads those to compute a field a branch snapshot shows.
 * `pendingInteractions` and `requestCosts` are not branch state: they are the root's, selected by the branch's
 * task and turn, and recomputed whenever the root's lists change.
 */
import type { WireBranchSnapshot, WireEvent, WireSnapshot } from './wire-events.js';

type Reduce = (state: WireSnapshot, event: WireEvent) => WireSnapshot;
type SubagentEvent = Extract<WireEvent, { type: 'subagent' }>;

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } as const;

function emptyBranch(event: SubagentEvent, branchId: string, turnId: string): WireBranchSnapshot {
  const { agentId, parentTurnId, rootTurnId } = event.payload;
  return {
    branchId,
    taskId: agentId,
    turnId,
    ...(parentTurnId !== undefined ? { parentTurnId } : {}),
    ...(rootTurnId !== undefined ? { rootTurnId } : {}),
    acceptedSeq: event.seq ?? 0,
    messages: [],
    tools: [],
    unmatchedToolResults: [],
    timeline: [],
    pendingInteractions: [],
    pendingBudgets: [],
    turnResults: [],
    usage: null,
    reasoning: null,
    reasoningIdentity: null,
    terminal: null,
    notices: [],
    requestCosts: [],
    queue: null,
  };
}

/** The branch as a snapshot the reducer can take; root-only fields are inert defaults. */
function scratch(root: WireSnapshot, branch: WireBranchSnapshot): WireSnapshot {
  return {
    protocolVersion: root.protocolVersion,
    sessionId: root.sessionId,
    backingSessionId: root.sessionId,
    seq: null,
    status: branch.terminal ? 'idle' : 'running',
    model: root.model,
    configuration: root.configuration,
    activeTurnId: branch.terminal ? null : branch.turnId,
    messages: branch.messages,
    tools: branch.tools,
    unmatchedToolResults: branch.unmatchedToolResults,
    pendingInteractions: [],
    pendingBudgets: branch.pendingBudgets,
    turnResults: branch.turnResults,
    admissions: [],
    usage: branch.usage ?? ZERO_USAGE,
    reasoning: branch.reasoning ?? '',
    reasoningIdentity: branch.reasoningIdentity,
    retryEligibility: { turn: false, tool: false },
    queue: [],
    queueState: 'idle',
    tasks: [],
    cost: null,
    goal: null,
    verification: null,
    notices: branch.notices,
    lastError: null,
    terminal: branch.terminal,
    timeline: branch.timeline,
  };
}

/** Folds one `subagent` event into its branch. Events without a branch identity only update the task row. */
export function reduceBranch(root: WireSnapshot, event: SubagentEvent, reduce: Reduce): WireSnapshot {
  const { branchId, turnId } = event.payload;
  if (branchId === undefined || turnId === undefined) return root;
  const branches = root.branches ?? [];
  const index = branches.findIndex((branch) => branch.branchId === branchId);
  const branch = index < 0 ? emptyBranch(event, branchId, turnId) : branches[index]!;
  const child = reduce(scratch(root, branch), event.payload.event);
  const next: WireBranchSnapshot = {
    ...branch,
    acceptedSeq: event.seq ?? branch.acceptedSeq,
    messages: child.messages,
    tools: child.tools,
    unmatchedToolResults: child.unmatchedToolResults ?? [],
    timeline: child.timeline,
    pendingBudgets: child.pendingBudgets ?? [],
    turnResults: child.turnResults ?? [],
    usage: branch.usage !== null || event.payload.event.type === 'usage' ? child.usage : null,
    reasoning: child.reasoningIdentity ? child.reasoning : null,
    reasoningIdentity: child.reasoningIdentity ?? null,
    terminal: child.terminal,
    notices: child.notices,
  };
  return {
    ...root,
    branches: index < 0 ? [...branches, next] : branches.map((entry, at) => (at === index ? next : entry)),
  };
}

const sameItems = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Re-selects each branch's share of the root's pending requests and costs; untouched branches keep identity. */
export function withRootShares(previous: WireSnapshot, next: WireSnapshot): WireSnapshot {
  const branches = next.branches;
  if (!branches?.length) return next;
  if (
    next.pendingInteractions === previous.pendingInteractions &&
    next.requestCosts === previous.requestCosts &&
    branches === previous.branches
  )
    return next;
  let changed = false;
  const shared = branches.map((branch) => {
    const pendingInteractions = next.pendingInteractions.filter(
      (request) => request.taskId === branch.taskId && request.turnId === branch.turnId,
    );
    const requestCosts = (next.requestCosts ?? []).filter((cost) => cost.turnId === branch.turnId);
    if (sameItems(pendingInteractions, branch.pendingInteractions) && sameItems(requestCosts, branch.requestCosts))
      return branch;
    changed = true;
    return { ...branch, pendingInteractions, requestCosts };
  });
  return changed ? { ...next, branches: shared } : next;
}
