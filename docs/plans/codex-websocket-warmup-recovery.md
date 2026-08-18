# Codex WebSocket warmup and corrupt-history recovery

Status: **implemented, then warmup removed (2026-08-18).** Recovery sends a fresh full-history inference request. Healthy WebSocket warmup no longer exists.

## Warmup was removed (2026-08-18 correction)

Read this before reintroducing a `generate:false` leg. The plan below aligned term2's
warmup with official Codex, which was the right correction at the time; the leg has
since been deleted outright because term2 called it at the wrong moment.

Warmup pays for itself only when it is issued ahead of an *upcoming* turn, so the
upload overlaps idle time. Term2 issued it inline, immediately before the request it
prepared, with nothing in between. Measured on real traffic
(`provider-traffic/2026-08-18/01-06-00_01306/`), that cost a serial round trip *and*
a duplicate prompt charge: the warmup reported 4,191 input tokens, and the paired
generate call reported the same 4,191 with `cached_tokens: 0`. No cache credit. The
prompt was counted twice on every cold request, and every mentor-pool consultation
is cold by construction, since each gets a throwaway session with no second turn.

Removing it costs no chaining. The response ID that anchors the next turn comes from
the generate response either way.

One trap this created, caught by `does not chain a tool output whose call is absent
from a rebuilt response chain`: the chain anchor in `codexFunctionCallIdsByResponseId`
-- the orphan guard's authority on which calls a response holds -- was recorded *only*
on the warmup leg. Deleting warmup silently disarmed the guard. It is now recorded by
the generate path, but **only for a full-history request** (`sentAsFullHistory`).
Recording it from a chained request would be a false-positive machine: a chained
request's `input` is just the delta, so the guard would reject every genuinely new
tool output as unknown to the chain.

If a future change wants the latency win back, the safe shape is Codex's *preconnect*
(<https://github.com/openai/codex/pull/10698>) -- a handshake-only warm socket opened
at session start that sends no `response.create` and therefore costs no tokens. That
is a different mechanism from the `generate:false` frame removed here.

## Resume here

Implemented. Chain recovery sets `disableChainingForAttempt` so Codex skips `previous_response_id` and `generate:false` warmup. Healthy warmup now sends the complete logical request; generation is an exact-extension delta. Identical rejected chain fingerprints terminate locally as `retry.conversation_state_no_progress`.

## Resume here

Conversation `3281ca05-cc92-4a25-b686-5c4e969fc17c` proves that term2 recognizes a provider rejection as chain corruption but rebuilds the same invalid request twice. The provider reports:

```text
No tool call found for function call output with call_id call_TPLbZgMcqd0guPBWHwDh1zjK.
```

The two retries are byte-equivalent in the load-bearing fields: each uses warmup response `resp_0c92da9f3e21513a006a7ca6ae955081919d93791700e69a20` as `previous_response_id` and sends the same 11 historical `function_call_output` items. The warmup input contains only `message, reasoning, message`, so that response never held the matching calls. Retrying cannot make progress.

The framing correction from first-party research is the starting point:

> Codex WebSocket warmup is connection setup and request reuse, not a semantic boundary inside conversation history.

Official Codex sends the complete logical request with `generate:false`, records the response, and lets its WebSocket session derive an incremental suffix when the normal request is an exact extension. Term2 instead partitions historical calls into warmup and historical outputs into generation. That custom partition created the orphan.

Implement the smallest safe correction first: **chain recovery bypasses semantic warmup partitioning and sends one fresh, validated full-history inference request without `previous_response_id`.** Then align healthy WebSocket warmup with official Codex as a separate step. Do not combine those changes before the recovery regression is green.

## Sources and evidence

- Official Codex `codex-rs/core/src/client.rs`: WebSocket prewarm is a `response.create` with `generate=false`, used so the next request can reuse the connection and `previous_response_id`; it is explicitly “connection setup, not an inference request.” <https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs>
- Official Codex incremental reuse compares the current complete logical request with the prior complete request plus server output. It sends a delta only for an exact extension; otherwise it sends the full request without chaining. Same source as above.
- Official endpoint tests exercise warmup followed by normal generation and tool-output continuation. <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses_websocket.rs>
- OpenAI Node’s manual-state example preserves complete ordered response output for replay. <https://github.com/openai/openai-node/blob/main/examples/responses/manual-conversation-state.ts>
- Local provider traffic for the reproduction is under `~/.local/state/term2-nodejs/logs/provider-traffic/2026-08-12/17-00-18_3281c/`.
- The durable conversation journal is `~/.local/share/term2-nodejs/conversations/3281ca05-cc92-4a25-b686-5c4e969fc17c.jsonl`.

## Destination

Term2 has one provider-facing logical request for a model invocation. WebSocket compression may change the wire representation only after proving that the new logical request is an exact extension of server-held state. Recovery always has a progress-making fresh-request path that does not depend on a stale response ID or on splitting tool pairs across requests.

## Invariants

1. A full-history request contains only structurally valid replay items. Every replayed tool result has one matching replayed tool call, and every replayed call that requires an output has one result.
2. Tool calls and outputs are normalized and validated before transport-specific slicing.
3. Warmup receives a complete logical request. It does not define an application-level boundary between calls and outputs.
4. `previous_response_id` is used only when the client can prove exact prefix compatibility with the response that ID names.
5. Chain recovery clears both application continuity and provider-local WebSocket chain state.
6. A recovery attempt must differ materially from the rejected request: no stale response ID and no known orphan output. Identical invalid retries terminate locally rather than spend the budget.
7. Recovery remains bounded by the existing transient retry count.

## Implementation sequence

### 1. Lock down the real failure at the provider-session seam

Add a regression scenario based on the captured conversation before changing production code.

Primary test location: `source/providers/codex-responses-model.test.ts` for request preparation, plus a session-level test in `source/services/session/` if the existing fixtures can drive retry through `AgentClient` without recreating half the runtime.

Fixture history must include:

- replayed/wrapped `tool_call` and `tool_result` items using the representation emitted by conversation replay;
- at least one call ID matching `call_TPLbZgMcqd0guPBWHwDh1zjK` in shape, with harmless synthetic content;
- a fresh resumed user message;
- a fake provider that rejects any `function_call_output` whose call is absent from the named response chain.

Assertions:

- The pre-fix implementation sends an orphan output and receives the exact provider error.
- Recovery’s next transport request has no stale `previous_response_id`.
- Every transmitted tool output has a matching call in the same full request.
- The model generates exactly once after repair; tool effects are not re-executed.

Completion criterion: the test deterministically reproduces the reported 400 before production changes and distinguishes a valid fresh replay from merely classifying the error.

### 2. Give chain recovery an explicit fresh-request instruction

Current `chain_recovery` maps to generic `retry_fresh` with `inputMode: 'full_history'`, but Codex provider preparation can immediately create a new warmup chain and reconstruct the same invalid split.

Edit:

- `source/services/retry/retry-contracts.ts`
- `source/services/retry/recovery-policy.ts`
- `source/services/retry/recovery-executor.ts`
- their colocated tests

Represent the required behavior explicitly, either by adding `disableChainingForAttempt: true` to the retry instruction or by introducing a narrowly named fresh-history mode. Prefer a flag on the existing retry instruction unless another caller needs a distinct policy branch.

The executor must:

- clear `ProviderContinuity`;
- preserve the existing tool-ledger settlement and projection behavior;
- instruct the next provider request to bypass both `previous_response_id` and Codex warmup/delta compression for that attempt.

Do not make retry policy know Codex wire details. It declares “fresh full-history request”; the provider adapter owns how that is represented.

Completion criterion: recovery produces an observable instruction that provider code cannot reinterpret as a chained warmup attempt.

### 3. Add a Codex full-history inference path that bypasses warmup

Edit `source/providers/codex-responses-model.ts` at the request-preparation boundary (`#prepareCodexServerHistoryRequests`, `#prepareCodexServerHistoryRequest`, and the unary/stream call sites around them).

When the fresh-history instruction is present:

- omit `previousResponseId`;
- invalidate or bypass `codexPreviousResponseIds`, `codexFunctionCallIdsByResponseId`, consumed-result state, and relevant `ChainedWireState` state for the request key;
- send one normal generating request containing the validated complete history;
- do not send a `generate:false` request for this recovery attempt.

Keep HTTP and WebSocket behavior semantically identical. WebSocket may still open a connection; it simply must not use the history warmup compression path for this request.

Completion criterion: the captured corrupt session shape succeeds through a single fresh inference request and establishes new continuity only from the successful response.

### 4. Normalize and validate replay history before transport slicing

The full-history path still needs valid provider input. Reuse the canonical conversation normalizer rather than expanding a second list of provider-specific wrapper cases.

Review and edit as required:

- `source/services/conversation/run-item-normalizer.ts`
- `source/services/conversation/conversation-state-projector.ts`
- `source/providers/codex-responses-model.ts` (`normalizeCodexServerHistoryItem` and `dropUnpairedCodexToolItems`)
- `source/lib/chained-input-filter.ts` only if its public pairing helpers can become the shared owner without introducing provider semantics

Decide one owner for pairing repair. Preferred ownership is conversation projection: it has complete history and the tool ledger. The Codex adapter should validate its input and fail closed, not independently invent a different repair.

Repair rules:

- Preserve complete call/result pairs in original order and provider representation.
- Remove an orphan result when no matching call can be recovered.
- For an unmatched call whose execution status is known, reuse existing ledger projection to synthesize the appropriate aborted/unknown result; do not execute it again.
- Preserve reasoning/message ordering and opaque provider items.
- Emit structured warnings containing removed call IDs, never tool output bodies.

Completion criterion: projection returns a self-contained history, and Codex validation proves all tool outputs are paired before network I/O.

### 5. Align healthy warmup with official Codex semantics

After recovery is green, simplify ordinary Codex WebSocket warmup:

1. Build one complete logical request.
2. On a fresh compatible WebSocket session, send that complete request with `generate:false`.
3. Record the exact logical request and returned response ID.
4. For normal generation, derive the wire delta only when the current logical request is an exact extension of the recorded request plus known response output.
5. Otherwise skip chaining and send the complete request normally.

The existing `ChainedWireState` is the likely owner of exact-extension bookkeeping. Deepen that module rather than retaining parallel state across `codexPreviousResponseIds`, consumed-result maps, and ad hoc history slicing if those structures represent the same fact. Do not perform a broad state refactor unless the regression requires it; document follow-up opportunities separately.

Delete the semantic call/output partition from `#prepareCodexServerHistoryRequests`. `findServerManagedDeltaStart` may remain for established response chains if its contract is exact-extension slicing, but it must not manufacture a fresh history chain from arbitrary replay.

Completion criterion: warmup and generation are two wire encodings of the same logical request, demonstrated by tests that reconstruct and compare their effective inputs.

### 6. Prevent identical recovery retries

At the retry/request boundary, retain a small fingerprint of rejected chain-state requests using only:

- provider and model;
- `previous_response_id`;
- ordered input item types and call IDs;
- recovery class.

If chain recovery would transmit the same fingerprint again, classify it as unrecoverable locally and log `retry.conversation_state_no_progress`. Do not hash text or tool outputs; they are irrelevant to this invariant and may contain sensitive data.

This is a backstop, not the primary repair. The first recovery attempt must still construct a fresh request.

Completion criterion: a deliberately broken repair fixture performs at most one duplicate-prone recovery attempt and surfaces a precise local diagnostic.

### 7. Add provider black-box coverage

Add a deterministic scenario to `scripts/provider-black-box/provider-session-resilience.blackbox.ts` and the owning fake provider fixture.

Scenario:

1. Persist or load a transcript containing a completed tool pair.
2. Start a resumed Codex session with no valid server response chain.
3. Have the fake provider reject an orphan output if one appears.
4. Assert term2 sends a fresh, paired full-history request and reaches a real terminal completion.

Important assertions:

- no stale `previous_response_id` on the recovery request;
- no orphan outputs;
- no duplicated tool execution;
- exactly one user-visible chain-recovery event;
- new successful response continuity is used on the following turn.

Update the provider capability ledger if the suite requires an explicit scenario declaration.

Completion criterion: the shipped CLI recovers the persisted-session case through the registry and real request-building path.

## Error handling and observability

- Continue classifying both provider messages as `chain_recovery`:
  - `No tool output found for function call ...`
  - `No tool call found for function call output with call_id ...`
- Log the repair summary: stale chain cleared, orphan call IDs removed, synthetic settlements added, and whether warmup was bypassed.
- User presentation remains “Conversation state was rejected by the provider. Rebuilding context and retrying...” for a progress-making attempt.
- If validation cannot produce a self-contained transcript, terminate with a message that says local history is structurally incomplete. Do not send a known-invalid provider request.

## Validation

Run in this order:

1. Focused red/green tests for `codex-responses-model`, history projection, retry policy, and recovery executor.
2. `pnpm test source/providers/codex-responses-model.test.ts source/services/retry source/services/session`
3. `pnpm typecheck`
4. `pnpm test:provider-black-box` — mandatory for provider and recovery changes.
5. `pnpm test` if shared projection or `ChainedWireState` behavior changes beyond Codex.
6. Re-run the real resume command against a copied/isolated conversation fixture. Do not mutate the user’s durable conversation during automated validation.

Record pre-existing failures separately. The provider black-box suite previously showed an unrelated traffic-persistence failure: `openai-http: no application-owned response traffic was persisted`.

## Acceptance criteria

- Resuming the captured conversation no longer sends `call_TPLbZgMcqd0guPBWHwDh1zjK` as an orphan output.
- The first chain-recovery attempt materially changes the request and succeeds when history is repairable.
- Recovery does not re-execute completed or unknown tools.
- Fresh recovery works over Codex HTTP and WebSocket transports.
- Healthy WebSocket warmup represents the complete logical request and is used only as transport compression.
- Exact-extension checks gate every use of a remembered response ID.
- Focused tests, typecheck, and provider black-box validation pass, apart from explicitly reproduced pre-existing failures.

## Assumptions and defaults

- `generate:false` is a Codex backend/WebSocket extension, not a portable public Responses API contract; keep it inside the Codex adapter.
- Correctness beats warmup performance during recovery. One uncompressed full-history inference request is the default recovery path.
- Existing tool-ledger settlement semantics (`aborted` for never-dispatched, `unknown` for dispatched-but-unobserved) remain authoritative.
- The persisted transcript is the durable source of truth after a stale or absent provider chain.

## Risks and open questions

- Confirm whether the Codex backend accepts a normal full-history WebSocket inference request without a preceding `generate:false` request. Official source strongly implies yes when incremental reuse is unavailable; pin this with the fake server and, if necessary, a sanitized live canary.
- Conversation projection may lack enough provider detail to replay some historical function calls. The safe fallback is to remove the pair from provider input while retaining user-visible transcript records, not to synthesize executable arguments.
- Large resumed histories may make a full recovery request expensive. Correctness lands first; compaction is a separate policy and must not be silently triggered by corruption recovery.
- If `ChainedWireState` and Codex-local response maps encode overlapping continuity, consolidating them may be warranted, but it is not required for the first fix.
