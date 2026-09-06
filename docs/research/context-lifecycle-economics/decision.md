# Context lifecycle: decision from retained evidence

Date: 2026-09-06. Scope: policy direction, not a claim that a new runtime policy is deployed.

## Decision

Keep size-triggered compaction as context-capacity management. Prefer an agent-authored rollover at a meaningful handoff boundary when substantial work remains and the current working set can be externalized. Do not compact every turn, lower the automatic threshold, or enable forced automatic rollover on the strength of this corpus. Enable live-work-preserving rollover only after ownership and fresh-context tests pass.

The opportunity is to separate coordinator conversation lifetime from execution lifetime, not to minimize every request in isolation. Existing background work should not force the coordinator to carry an unrelated accumulation of history. Pending interactions and queued user work remain separate safety constraints.

## What changed the decision

The rerunnable [corpus report](../context-lifecycle-economics.md) covers 22,781 deduplicated request envelopes over August 31 through September 5. Approximately 95% of measured ordinary input is cached. Large contexts are therefore cheaper than full-price token counts suggest, but cached reads are not free. Repeatedly reading a large cached prefix can still dominate input cost.

Fourteen predecessor/successor links verified by durable rollover metadata have matching-lane usage pairs. Their aggregate predecessor input is 2,961,357 tokens and first-successor input is 283,857: approximately 211,526 versus 20,276 per pair, a 90.4% size reduction. First-successor uncached input totals 271,313, demonstrating an actual cache-warm cost rather than assuming cache continuity. These are observational size measurements, not measured task savings. Matching provider/model/mode/available metadata does not establish root identity when multiple actors share that lane.

For sensitivity only, price the entire first-successor input at the uncached rate and suppose the observed removed history would otherwise be reread at the cached rate on each future request. The aggregate warm-cost proxy is recovered after more than 10.6 requests at a 1% cached-price ratio, 1.06 requests at 10%, or 0.42 requests at 25%. Round up to 11, 2, and 1 requests respectively. These are not automatic-rollover thresholds: handoff generation, extra output, rereading, quality loss, cache writes, changing context sizes, and alternative-path costs are excluded. An aggregate ratio is not a per-session guarantee.

This corrects two overly simple arguments: neither "95% cached means keep history indefinitely" nor "90% smaller means always roll over" follows. The relevant quantity is future repeated input cost minus reset and recovery costs, subject to maintaining task correctness.

Native compaction evidence is sparse and historically failure-heavy: 214 structurally identified trigger requests and one explicit replay-marker request in the selected wire corpus. Local summary success is not separately identifiable from retained logging. This does not prove that successful local compaction never happened, nor that historical native failures remain in current code. There is not enough comparative evidence to prefer a new local-compaction cadence.

The previous controlled retrieval study also matters: a diagnosis-rich coding continuation was cheaper after rollover ($0.0347 versus $0.0431), but two short continuations were more expensive because of extra retrieval. See [session retrieval observed usage](../session-retrieval-observed-usage.md). This favors task-boundary judgment over a fixed reset schedule.

## Operational policy

- Continue while unresolved reasoning or exact evidence remains central, particularly for a short remaining step. Do not reset solely because the session is old.
- At a completed phase, consider rollover if many further requests are likely. Externalize the next step, decisions, constraints, verification, relevant artifacts, and open questions rather than narrating history.
- Preserve worker execution and control independently of coordinator history. Successor task inventory should be supplied by the harness, not depend on the brief remembering handles.
- Use compaction when context capacity requires it and a valid cut exists. Retain the existing threshold and hysteresis until successful local-compaction costs and fidelity can be compared.
- Keep rollover optional. The agent knows whether its current reasoning can be handed off; raw size does not.

## Acceptance for live-work rollover

The first transfer-based implementation was rejected in review: old-client closures, approval ownership, and dispose-before-create failure paths could strand work. Prefer retaining execution owners while explicitly resetting root conversation state. That choice still needs proof of complete root reset; it is not safe merely because it avoids disposal.

Required invariants: the first new root request contains only fresh instructions/handoff rather than old transcript or provider chain; original job and subagent IDs remain controllable; original child permissions/workspaces remain; approvals after rollover route to the current coordinator without widened authority; watches, notifications and check-ins survive without duplicate consumers; failed preparation leaves the predecessor usable; ordinary clear/shutdown still dispose work.

## Limits and next evidence

This corpus supports the enabling feature and the policy above, not a calibrated automatic scheduler. Future observational work should retain explicit actor/request-purpose identity and structured local-summary usage so helper calls cannot be mistaken for root context growth. A causal comparison must include handoff and retrieval cost and a task-outcome oracle, not only input-token reduction. No paid live experiment or model-price assumption is necessary to ship the bounded lifecycle feature.
