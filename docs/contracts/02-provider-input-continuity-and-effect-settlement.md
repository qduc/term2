# Contract 02 — Provider input, continuity, and effect settlement

Status: **owner-reviewed 2026-08-14; focused command green.** Owners:
`ToolExecutionLedger` + history projection (`conversation-state-projector`),
`ProviderContinuity`, `SessionInputPlanner`, `ChainedInputFilter`,
`SessionStreamProcessor` (finalize and debt sync), and retry/recovery policy
(`retry-classifier`, `recovery-policy`, `DefaultRecoveryExecutor`).

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C2.1 | Every provider-facing tool result has one matching call in the applicable full-history request or live provider chain. | Provider rejection (400) of orphaned results; duplicated call/result pairs that replay an effect a second time. |
| C2.2 | Ledger reconciliation cannot duplicate, reorder, or resurrect a settled pair across replay or compaction boundaries. | Re-executing side effects from before a compaction checkpoint; corrupted history visible to the provider. |
| C2.3 | A live chain with unpaid tool debt is either paid completely or dropped before the next request. | The next text-only continuation fails with a server 400 and the turn is stuck with no recovery. |
| C2.4 | Chained delta validation and full-history validation remain distinct; a transport downgrade is allowed only after local history, continuity, and effect state are safe for replay. | Invalid chained deltas looping into provider 400s; downgrading to full history before state is safe, which can replay ambiguous effects. |
| C2.5 | Never-dispatched effects settle as `aborted`; dispatched-but-unobserved effects settle as `unknown` and are never blindly re-executed. | Blindly re-running a command whose execution outcome is unknown (duplicate side effects, data loss). |
| C2.6 | Provider-native opaque state remains provider-scoped. | Another provider reserializes opaque state it does not understand and corrupts the conversation or breaks resume. |
| C2.6a | A foreign `provider_opaque` item never serializes into another provider's request. | Resume/compaction blob sent to the wrong vendor; provider 400 or silent history corruption. |
| C2.6b | Same-provider opaque is allowed **only** on adapters that own an opaque lane: OpenAI Responses (`provider === 'openai'`) and Chat Completions / runtime-compatible (`tag === providerId` **or** legacy `'openai-compatible'`). Codex and AI SDK do not own an opaque lane: their public adapters drop every `provider_opaque` item before serialization, while their lower-level serializers reject a bypassed item. | “Allow own tag” on Codex/AI SDK would be a lie: they have no opaque round-trip. The four adapter/converter proofs below establish fail-closed non-serialization; Codex output conversion also rejects unknown item types (`codex-responses-model.ts:326-349`) and never emits `provider_opaque`. |
| C2.6c | Production turns use `stream()`. Missing `getResponse` is not a defect. If `getResponse` exists, it must apply the **same** splice/non-serialization rules and must not treat `failed`/`incomplete` as success. | Unary success on a failed Responses body would look like a completed turn to any future caller. |

## 2. Owners

- **Enforcement:** `ToolExecutionLedger` (call/result pairing, statuses,
  reconciliation rules); `conversation-state-projector.ts` (merging ledger
  pairs into provider history; replacement boundaries); `ProviderContinuity`
  (chain and debt); `SessionInputPlanner` (chain vs full-history decision);
  `ChainedInputFilter` (delta validation); `SessionStreamProcessor` (finalize,
  `publishTerminalResponse`, debt sync); retry classification/policy.
- **C2.6 adapter isolation (enforcement):** `toResponsesApiInput` (`openai-responses-model.ts:84-122`),
  `openAICompatibleMessages` (`openai-chat-completions-model.ts:294-333`), `toPromptMessage`
  (`ai-sdk-streamed-model.ts:260-284`), and `toCodexResponsesItem` (`codex-turn-converter.ts:17-50`).
  History carry is `ApplicationRunLoop` (`application-run-loop.ts:1159-1166`), which turns
  terminal opaque output into `provider_opaque` input items (`:1864-1867`).
- **Recovery:** `DefaultRecoveryExecutor` (`resume_stream`, `replay_turn`,
  `retry_fresh`, `terminate`); ledger settlement on stream failure
  (`settleOpenCallsOnStreamFailure`, `markOpenCallsAborted`);
  `retry-classifier`/`recovery-policy` (chain_recovery, transport_downgrade ->
  `retry_fresh` full-history).

## 3. Execution paths that share the contract

- Chained requests (delta input via `previous_response_id`).
- Forced-full-history requests (no chain / chain dropped).
- Transport downgrade (WebSocket lifetime error -> HTTP fallback).
- Compaction and replacement boundaries (OpenAI opaque compaction, local
  summary checkpoints).
- Save/resume and stateless replay (local envelope durability, sidecar recovery, and atomic replacement are governed by [Contract 08](./08-conversation-durability-and-recovery.md); Contract 02 governs provider-facing item and ledger semantics of replayed turns).
- Adapter serialize/splice of persisted `provider_opaque` items (C2.6a–c): OpenAI Responses
  HTTP + WS + unary `getResponse`, Chat Completions (built-in and runtime-compatible), AI SDK
  unary + stream, Codex HTTP + WS.
- Complete and partial parallel tool-call batches.
- Pre-stream and mid-stream transport failure; failure before and after
  dispatch.
- Approval pause and continuation.

## 4. Identities and state crossing the boundary

- `callId` pairs — a ledger entry records `turnId`, `callId`, `toolName`,
  `status`, `output?`, `dispatchedAt?`, `historyItems`
  (`tool-execution-ledger.ts:12-25`). `ToolExecutionStatus`:
  `'started' | 'completed' | 'failed' | 'approval_required' | 'aborted' | 'unknown'`
  (`:4`).
- `previousResponseId` + `outstandingToolCallIds` in `ProviderContinuity`
  (`provider-continuity.ts:60-81`); unpaid debt = active calls minus completed
  results (`session-tool-tracker.ts:78-86`).
- Replacement boundary: an OpenAI opaque `compaction` item or a local context
  summary (`conversation-state-projector.ts:35-55`).
- `ProviderInputItem.providerOpaque?: { provider }` and persisted
  `provider_opaque` items (`source/contracts/provider-input.ts:20-42`;
  `conversation-turn-items.ts:94-105`).
- `inputSurgeKind: 'delta'` for chained input (`session-input-planner.ts:211-230`).
- Adapter lane ownership: the acceptance rule lives once in
  `providers/provider-opaque-compatibility.ts` and keys on the *lane* tag, not the provider id.
  A Responses adapter splices only its own lane tag, which it takes as a parameter
  (`OPENAI_RESPONSES_OPAQUE_TAG = 'openai'` by default, `GROK_RESPONSES_OPAQUE_TAG = 'grok'`
  for Grok — a second vendor on the same wire shape whose ciphertext is not interchangeable);
  the Responses lane never honours the legacy shared tag
  (`provider-opaque-compatibility.ts:31-79`). Chat Completions
  splices `tag === providerId` or legacy `'openai-compatible'`, where the runtime-compatible
  tag is `opaqueProviderTag(config)` = `config.name || config.type || 'openai-compatible'`
  (`openai-compatible.provider.ts:51-52`); AI SDK and Codex drop every tag at their public request boundary, with lower-level serializer guards for bypasses.

## 5. Settlement semantics

- **Success:** terminal finalize commits history, calls
  `publishTerminalResponse(snapshot.lastResponseId, ...)`, then syncs debt
  (`session-stream-processor.ts:390-441`).
- **Failure before dispatch:** undispatched open calls -> `aborted` with a
  synthetic result equal to the failure reason; dispatched calls -> `unknown`
  with the `UNKNOWN_OUTCOME_TOOL_RESULT` message ("Verify the current state
  before any retry, and do not re-run non-idempotent operations blindly",
  `tool-execution-ledger.ts:6-10`, `:315-347`).
- **Cancellation/terminate:** `terminate` settles open calls and reconciles
  history when a stream exists, then always calls `providerContinuity.clear()`
  so no live `previousResponseId` remains (`recovery-executor.ts:100-130`;
  "the next text-only continue otherwise gets a 400", `:115-118`); emits
  `tool_recovery` with `{ recoveredCallIds, droppedCallIds, message }` when
  there is a summary (`:120-128`).
- **Retry:** `resume_stream` -> `skipUserMessage` + saved resume state +
  `resumePreviousResponseId`; `replay_turn` -> clear continuity + import ledger
  journal; `retry_fresh` -> clear continuity + full history
  (`recovery-executor.ts:29-91`).
- **Ambiguous:** `unknown` is not a failure; ledger counts dropped pairs via
  `getRecoverySummary` (`tool-execution-ledger.ts:412-439`); replayed
  call/result pairs are dropped before history commit with a
  `conversation.stream_history.replay_dropped` event
  (`session-stream-processor.ts:367-385`).
- **Opaque isolation (C2.6):** success = own-tag spliced verbatim (Responses/Chat only);
  a foreign or unsupported item is dropped before the HTTP/WS/SDK call at the public
  adapter boundary; the lower-level AI SDK and Codex serializers throw an untyped `Error`
  if a caller bypasses that filter, with a message containing `provider_opaque` and the
  offending tag. Cancellation = `request.signal` aborts an in-flight Responses create;
  retry = `RetryingModel` retries only pre-event network/upstream errors, so opaque
  non-serialization is never replayed as a transport retry (`retrying-model.ts`;
  `AmbiguousModelOutcomeError` is likewise not retried, `retrying-model.test.ts:31`).

## 6. Observability

- Events: `conversation.stream_history.replayed_tools`,
  `conversation.stream_history.replay_dropped` (`session-stream-processor.ts:150-175`,
  `:367-385`); `conversation.chaining_broken` ("WS-to-HTTP downgrade detected:
  chaining disabled, switching to full-history mode",
  `session-composition.ts:584-592`); `retry.conversation_state` ("Provider
  rejected conversation continuity, rebuilding full history",
  `retry-event-presenter.ts:81-89`); `retry.transport_fallback` (`:102-109`);
  `tool_recovery` conversation event.
- Provider traffic: `${eventPrefix}.request.started`, `provider.response.failed`,
  `${eventPrefix}.response.received`, `${eventPrefix}.response.closed`
  (`source/services/logging/provider-traffic.ts:1022-1230`).
- Opaque refusal (C2.6) has **no** log event: the thrown message is the only signal
  (`Refusing to splice provider_opaque from '<tag>' ...` /
  `Refusing to serialize provider_opaque from '<tag>' ...`).
- Diagnosis: a 400 on continue after a failed stream means unpaid debt survived
  (C2.3 violated); replayed pairs logged before history commit mean
  reconciliation diverged (C2.2).

## 7. Public boundary under test

- `ToolExecutionLedger` public methods (record/mark/settle/reconcile) —
  `tool-execution-ledger.test.ts`.
- `ProviderContinuity` (chain, debt, eligibility, clear/breakChaining) —
  `provider-continuity.test.ts`.
- `SessionInputPlanner.build/replayFromHistory` — `session-input-planner.test.ts`.
- `filterChainedModelInput` — `chained-input-filter.test.ts`.
- `DefaultRecoveryExecutor` (resume/replay/retry/terminate) —
  `recovery-executor.test.ts`.
- `SessionStreamProcessor.finalize` (commit + debt sync) —
  `session-stream-processor.test.ts`.
- Local compaction boundaries — `local-context-compactor.test.ts`.
- Retry classification/policy — `retry-classifier.test.ts`,
  `recovery-policy.test.ts`.
- C2.6 adapter opaque lanes — `openai-responses-model.test.ts` (unary own-tag
  splice and foreign-item drop), `openai-chat-completions-model.test.ts` (foreign
  and same-type/different-id drops), `openai-compatible.provider.test.ts`
  (runtime-compatible tag = config name), `ai-sdk-streamed-model.test.ts` (unary
  foreign-item drop), and `codex-turn-converter.test.ts` (foreign/own-tag drops
  plus direct converter rejection). These four adapter/converter files are the
  fail-closed provider_opaque proofs; `retrying-model.test.ts` covers stream retry
  and unary absence.

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence (file:title) | Status |
| --- | --- | --- |
| Complete parallel tool-call batch | `openai-chat-completions-model.test.ts:394` "application tool continuation keeps one reasoning-bearing assistant message for parallel tool calls"; `openai-chained-input-compatibility.test.ts:42` "preserves trailing tool-result selection and selected parallel outputs exactly" | covered |
| Partial parallel tool-call batch | `session-input-planner.test.ts:54` "uses self-contained full history for a partial parallel tool batch"; `chained-input-filter.test.ts:419` "forwards only the completed result from a partial parallel batch" | covered |
| Pre-stream transport failure | `recovery-executor.test.ts:337` "retry_fresh without stream preserves user message and clears continuity"; classification covered by `retry-classifier`/`retry-error-classification` tests | covered |
| Mid-stream transport failure | `recovery-executor.test.ts:109` "retry_fresh with stream reconciles history and restores ledger"; `:151`, `:199` | covered |
| Failure before dispatch | `recovery-executor.test.ts:151` "marks never-dispatched in-flight calls as aborted and injects error results"; `tool-execution-ledger.test.ts:733` | covered |
| Failure after dispatch | `recovery-executor.test.ts:199` "marks dispatched in-flight calls as unknown, not failed" | covered |
| Approval pause and continuation | `turn-workflow.test.ts:646` "executeInitial resolves aborted approvals through continuation"; `:580` "returns each later post-execute pause from the same live stream" | covered |
| Compacted history | `session-stream-processor.test.ts:77` "finalize() replaces history with user turns and the last OpenAI compaction item"; `local-context-compactor.test.ts:11` "reduces cold turns sequentially and returns a marked checkpoint plus verbatim hot tail" | covered |
| Replacement boundaries | `conversation-state-projector.test.ts:88` "does not reinsert tool pairs behind a compaction marker"; `:106` "preserves a pre-boundary tool fragment instead of reinserting its ledger pair" | covered |
| Save/resume | `conversation-replay.test.ts:1195` "assistant_turn rebuilds structured assistant history for resume"; `recovery-executor.test.ts:31` "resume_stream returns run instruction with resume state" | covered |
| Stateless replay | `tool-execution-ledger.test.ts:515` "dropUnpairedFunctionCalls removes function_calls without a matching output"; `:530` "removes function_call_outputs without a matching call" | covered |
| Orphan call/result item | `tool-execution-ledger.test.ts:515`, `:530`; `chained-input-filter.test.ts:357` "rejects an expected tool output whose function_call is missing from the input" | covered |
| Duplicate item | `tool-execution-ledger.test.ts:216` "recordFunctionCall preserves existing historyItems on a duplicate call"; `session-stream-processor.test.ts:1360` "dedupes equivalent wrapped, canonical, and provider result representations" | covered |
| Missing item | `chained-input-filter.test.ts:265` "rejects an empty chained delta when tool outputs are required"; `retry-classifier.test.ts:157` "classify returns bounded chain recovery when a chained continuation is missing required tool output" | covered |
| Out-of-order item | `conversation-state-projector.test.ts:53` "replaces a lone compact tool result with the ledger pair instead of duplicating it" | covered |
| Chained request | `session-input-planner.test.ts:7` "carries the authoritative immutable history snapshot alongside the unchanged input plan"; `chained-input-filter.test.ts:178`, `:400` | covered |
| Forced-full-history request | `session-input-planner.test.ts:27` "drops chaining and uses full history when the previous response still has unpaid tool debt" | covered |
| Transport-downgrade request | `recovery-policy.test.ts:58` "transport_downgrade produces retry_fresh with full_history"; `retry-classifier.test.ts:145` "classify returns transport_downgrade when the Responses websocket reaches its connection lifetime" | covered |

**C2.6 adapter-isolation cells (supplementary to the C2.1–C2.5 minimum matrix above):**

| C2.6 cell | Evidence (file:title) | Status |
| --- | --- | --- |
| OpenAI Responses own-tag splice | `openai-responses-model.test.ts:576` "splices an openai provider_opaque input item verbatim into the request" (unary) | covered |
| OpenAI Responses foreign fail-closed handling | `openai-responses-model.test.ts:605` "drops a non-openai provider_opaque item and still replays the rest of the history"; `openai-responses-model.ts:85-90` filters it before projection | covered |
| OpenAI Responses unary `failed`/`incomplete` rejected | `openai-responses-model.test.ts:712` "rejects unary %s responses before lifecycle terminal success" | covered |
| OpenAI Responses stream without terminal | `openai-responses-model.test.ts:734` "fails when an HTTP stream ends without a terminal completion" | covered |
| OpenAI Responses unknown output becomes opaque | `openai-responses-model.test.ts:537` "turns an unknown Responses output item into provider_opaque instead of throwing" | covered |
| Chat Completions exposes no unary | `openai-chat-completions-model.test.ts:13` "Chat model exposes only the application-owned streamed-turn contract" | covered |
| Chat Completions foreign fail-closed handling | `openai-chat-completions-model.test.ts:680` "drops provider_opaque from another provider and still sends the rest of the request"; `openai-chat-completions-model.ts:286-320` drops non-owned tags | covered |
| Chat Completions same-type different-id fail-closed handling | `openai-chat-completions-model.test.ts:718` "drops an opaque item from a different provider of the same openai-compatible type" | covered |
| Chat Completions own-tag splice | `openai-chat-completions-model.test.ts:747` "splices a trailing opaque payload onto its own turn, not an earlier assistant message"; `:788` "replaces reconstructed reasoning_content with the payload spelling rather than sending both" | covered |
| Runtime-compatible tag = config name | `openai-compatible.provider.test.ts:414` / `:455` emit `provider: 'provider-test'` | covered |
| AI SDK fail-closed handling | `ai-sdk-streamed-model.test.ts:355` "drops a provider_opaque item and still sends the rest of the history"; `ai-sdk-streamed-model.ts:228-244` filters before both stream/unary call options, while `:289-294` rejects a bypass | covered |
| Codex fail-closed handling | `codex-turn-converter.test.ts:126` / `:136` drop foreign and own-tag items; `:146` "still refuses a provider_opaque item handed straight to the per-item converter"; `codex-turn-converter.ts:13-17,46-55` filters then guards bypasses | covered |
| RetryingModel unary absence (green characterization) | `retrying-model.test.ts:123` "RetryingModel does not expose getResponse when the wrapped model has none" | covered |
| Persistence/replay of opaque items | `conversation-replay.test.ts:2075` "a provider_opaque item round-trips byte-identical through persistence and replay"; `:2122` "two provider_opaque items across turns both survive independently"; `application-run-loop.test.ts:27` "carries a providerOpaque-marked item through untouched as provider_opaque" | covered |

## 9. Verification commands

Focused (verified 2026-08-14, all green):

```sh
NODE_ENV=test pnpm test \
  source/services/tool-execution-ledger.test.ts \
  source/services/provider-continuity.test.ts \
  source/services/session/session-input-planner.test.ts \
  source/lib/chained-input-filter.test.ts \
  source/services/conversation/conversation-state-projector.test.ts \
  source/services/retry/recovery-executor.test.ts \
  source/services/agent-runtime/context-compaction/local-context-compactor.test.ts \
  source/services/session/session-stream-processor.test.ts \
  source/providers/openai-chat-completions-model.test.ts \
  source/providers/openai-chained-input-compatibility.test.ts \
  source/services/session/turn-workflow.test.ts \
  source/services/conversation/conversation-replay.test.ts \
  source/services/retry/recovery-policy.test.ts \
  source/services/retry/retry-classifier.test.ts
```

Result: **14 files / 355 tests passed.** This command corrects the Phase 0
baseline Seam 2 command, which referenced two nonexistent paths
(`source/lib/session-input-planner.test.ts`,
`source/services/context-compaction/provider-neutral-compactor.test.ts`) that
Vitest silently ignored; the real files are
`source/services/session/session-input-planner.test.ts` and
`source/services/agent-runtime/context-compaction/local-context-compactor.test.ts`.
It also includes every practical matrix-evidence boundary, including
`conversation-state-projector.test.ts` for reconciliation. See
`docs/contracts/README.md` for the full discrepancy record. Classification:
**test defect in the baseline record, not a product defect.**

Supplementary C2.6 adapter-isolation command (C2.6 focused gate, verified
2026-08-16 in `.worktrees/sb07-type-hardening`; the four adapter/converter
proof files are the required fail-closed subset):

```sh
NODE_ENV=test pnpm test \
  source/providers/openai-responses-model.test.ts \
  source/providers/openai-chat-completions-model.test.ts \
  source/providers/ai-sdk-streamed-model.test.ts \
  source/providers/codex-turn-converter.test.ts \
  source/providers/openai-compatible.provider.test.ts \
  source/providers/retrying-model.test.ts \
  source/providers/registry.test.ts \
  source/services/provider-continuity.test.ts
```

Result: **8 files / 170 tests passed**. The four-file adapter/converter
subset independently passed **81 tests**; the historical 14-file command above
passed **14 files / 368 tests** in this checkout and remains the C2.1–C2.5 /
minimum-matrix gate.

Broader gates: `NODE_ENV=test pnpm test`, `pnpm typecheck`, and — mandatory
for provider/bridge/run-loop/registry/non-interactive changes per `AGENTS.md` —
`NODE_ENV=test pnpm test:provider-black-box` (19 files / 166 tests green at baseline commit).

## 10. Known gaps and classification

All minimum-matrix cells are covered. No product defect is demonstrated; any
future violation still requires a red proof through the public boundaries above
before a Phase 2 repair. The C2.6 additions are green characterizations of
current production behavior — no `it.fails` was written in this workstream.

- **Deferred type gap (SB-07, documentation-only; no repair authorized in this slice):**
  The reviewed baseline declaration for `ProviderFetch` was
  `(url: string, options?: any) => Promise<any>` at `source/providers/registry.ts:21`.
  It leaves the catalog/token-refresh fetch boundary structurally untyped. Record this
  as an owner decision; do not invent a second fetch seam or retype the declaration here.
- **Deferred unary decorator gap (SB-07, documentation-only; no repair authorized in
  this slice):** The reviewed baseline declaration was
  `StreamedModelTurn.getResponse?(...): Promise<any>` at
  `source/contracts/streamed-model-turn.ts:67`, and `RetryingModel` does not forward
  the optional unary method (`source/providers/retrying-model.ts`). The run loop uses
  `model.stream(request)` (`application-run-loop.ts:975`), and the green characterization
  at `retrying-model.test.ts:123` proves absence when the wrapped model has no unary
  capability. This records the type/decorator gap without retyping `getResponse`, adding
  a production unary seam, or changing runtime behavior.
- **Owner decision (SB-07) — unary return shape and forwarding:** A common unary
  return shape and whether `RetryingModel` should forward an optional unary capability
  remain deferred. This documentation slice does not retype `getResponse`, invent a
  production unary seam, or change the existing stream-owned runtime path.
- **Type/decorator residual hypothesis (green characterization, not a defect):**
  `RetryingModel` does not forward `getResponse` (`retrying-model.ts`). Its only production
  wrap is Codex (`codex.provider.ts:490`), whose model implements `stream` only
  (`codex-responses-model.ts:218-220`) and has no public unary; the run loop calls
  `model.stream(request)` (`application-run-loop.ts:975`). Characterized green in
  `retrying-model.test.ts:123`.
- **Implementation inconsistency / unproven:** OpenRouter and custom catalog listing ignore
  `deps.signal` (`openrouter.provider.ts`, `openai-compatible.provider.ts:318`) while OpenAI
  (`openai.provider.ts:64`) and Codex (`codex.provider.ts:399-401`) forward it; the only live
  signal caller is Codex default-reasoning (`agent-client.ts:736-746`), which forwards. The
  UI catalog cancels by request-id staleness, not HTTP abort. No red test.
- **Owner decision:** `createStreamedModel?` (`registry.ts:35`) — a missing factory already
  throws at use (`mentor-runner.ts:273`, `nested-runner.ts:390`, `agent-client.ts:388`).
- **Proven product defect in this workstream: none.**
