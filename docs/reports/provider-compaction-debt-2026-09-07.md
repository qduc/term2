# Provider compaction/tool-debt seam (2026-09-07)

## Disposition

The representative Luna failure T1 is causally established and is repaired in
the provider model. The failure was **stale Responses-Lite server history being
reused across a successful native compaction**, not loss of the local tool
result. The existing missing-output recovery then recovered by dropping the
chain and sending the compaction checkpoint without replaying the completed
tool effect.

This is scoped to `CodexResponsesWSModel` and its Responses-Lite wire-state
machine. No AgentClient, subagent tool-policy, or executor-timeout behavior was
changed.

## Bounded T1 reconstruction

The provider-traffic session is
`2026-09-06/01-59-40_d27dc/` and timestamps below are UTC (the incident report
records them as local UTC+07:00). The worker-specific headers identify
`d27dc356-4eda-4882-9c38-80d8aa46cdbd:subagent:swift-rose-779`.

1. At `02:46:30.234Z`, the worker sent a continuation with the prior response
   anchor ending in `406a`. Its input contained the tool output for the prior
   call, and the successful response issued the call later named in the
   provider error. This is the preceding call/output boundary, not a missing
   local result.
2. At `02:46:54.275Z`, a Codex compaction-trigger request returned HTTP 200.
   Its body contained the worker's complete history through that tool call and
   its output, followed by `compaction_trigger`. The later worker request
   carried the resulting opaque compaction item (ID beginning `cmp_03b...`).
   The trigger response's HTTP 200 is treated only as transport evidence.
3. At `02:48:38.472Z`, T1 sent one `compaction` input item together with the
   old `previous_response_id` ending in `406a`. The provider returned HTTP 400
   with `No tool output found for function call ...`; diagnostics recorded two
   heartbeat/unknown frames and no tool-call frames.
4. At `02:48:39.565Z`, existing `chain_recovery` ran. The worker's replacement
   request had no `previous_response_id` and contained the `additional_tools`
   prefix plus the compaction item. It returned HTTP 200. The replacement did
   not contain the completed tool output or a new tool call, so this recovery
   path did not replay that effect. A later 200 is not treated as proof of the
   review task's semantic completion.

The compaction-shaped input was therefore not an artificial missing-output
probe. The wider continuity report classifies T1 as live investigation/review
traffic and does not establish worker intent. This report relies only on the
bounded request/response artifacts above.

## Root cause

`ApplicationRunLoop` already clears its local response ID when it commits a
compaction replacement. However, Luna's provider model owns a second,
session-scoped chain in `ChainedWireState`. A successful
`CodexResponsesWSModel.compactHistory()` returned the opaque replacement item
without invalidating that provider-side chain. The next request therefore
combined the new compaction boundary with the old server response anchor. The
server validated the old response's unpaid function call before accepting the
replacement item and rejected the request as missing its output.

The local call debt was not silently discarded: the compaction-trigger input
contained the call/output pair, and the application retained the opaque
checkpoint. The stale server anchor made the replacement request structurally
invalid.

## Repair and regression proof

After a successful native compaction, `CodexResponsesWSModel` now invalidates
only the current `providerHistoryKey` in its Luna wire state and removes the
associated per-response bookkeeping. Failed compaction leaves the old chain
untouched, preserving the transactional history contract. Other provider keys
in the shared Codex model remain independent.

Regression test:

```text
NODE_ENV=test pnpm test source/providers/codex-responses-model.test.ts \
  -t "drops Luna server history at a native compaction boundary"
```

The test was red before the production change: the post-compaction request
carried the prior response ID. It is green after the change and asserts that
the checkpoint is sent as a new, unchained request. The test also seeds the
prior response with a function call, proving that the boundary removes stale
provider debt rather than merely testing an ordinary message turn.

## Context ownership follow-up

The T1 compaction-trigger artifact has a root-session HTTP header while its
body is the worker's history. The code trace and caller-seam regression now
establish that this is not a worker-chain ownership mismatch. The Codex HTTP
header middleware deliberately uses the conversation `sessionId` for its
request metadata, while the Luna chain and WebSocket identity use the
`providerHistoryKey`. Automatic native compaction is invoked at the
`ApplicationRunLoop` request boundary, and `SubagentAsyncRegistry` wraps every
worker segment in that worker traffic context; the context survives the
`AgentClient` compaction call and the following stream request.

The focused caller-seam test observes the worker key for both operations. The
provider-model tests additionally use real `AsyncLocalStorage` contexts to
prove that successful compaction drops only the worker key (the root key still
chains) and that a failed compaction leaves the worker chain, including its
function-call debt, intact. No real external provider call or live rollover
was used for these regressions.

