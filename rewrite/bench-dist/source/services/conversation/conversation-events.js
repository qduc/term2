export function formatMemoryReceipt(memories) {
    const names = memories.map(({ scope, id, title }) => `${scope} / ${id} — ${title}`).join('; ');
    return `Loaded ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}: ${names}`;
}
/**
 * Event kinds that carry no committed model output and take no externally
 * effectful action -- pure telemetry/lifecycle bookkeeping about the
 * request. Notably, cost_update fires even for a request that produced
 * nothing (its own `outcome` can be 'failed'), so treating its presence as
 * "output was committed" would block safe recovery for the common case of a
 * request that failed before ever streaming anything.
 */
const BOOKKEEPING_ONLY_EVENT_TYPES = new Set([
    'reasoning_started',
    'memory_injected',
    'usage_update',
    'subagent_usage_update',
    'cost_update',
    'run_budget',
    'subagent_run_budget',
    'codex_rate_limits',
    'context_compaction_started',
    'context_compaction_completed',
    'context_compaction_failed',
    'background_check_in_due',
]);
/**
 * True when this event represents user-visible model output or an
 * externally effectful action (a dispatched tool call, an approval
 * requirement, a final response, ...). Used to decide whether an attempt has
 * done anything that would make an automatic replay unsafe -- see
 * TurnAttempt.markModelEventSeen and the "never replay after committed
 * output" guard in retry-classifier.ts.
 */
export function isCommittedOutputEvent(event) {
    return !BOOKKEEPING_ONLY_EVENT_TYPES.has(event.type);
}
//# sourceMappingURL=conversation-events.js.map