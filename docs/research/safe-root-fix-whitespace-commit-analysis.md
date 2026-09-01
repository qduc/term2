# Safe root fix for in-band SSE error committing via trivial whitespace

**Date:** 2026-09-01 · **Type:** research — safe approach to root fix · **Status:** analysis complete, fix not implemented
**Question:** How to stop yielding the `" "` chunk before an in-band SSE error frame (or treat it as pre-commit in `RetryingModel`) without taking the high-risk streaming/commit invariant change in one shot?

## TL;DR

- **Wire truth (primary):** OpenInference via OpenRouter returns `200 + text/event-stream` with **two** SSE `data:` frames for the same logical turn: `choices:[{finish_reason:"error", delta:{content:" "}}]` (1-space) **and** `choices:[] + error:{code:502, message:"Upstream error from OpenInference: Model is at capacity", metadata:{error_type:"provider_unavailable"}}`. Source: `~/.local/state/term2-nodejs/logs/provider-traffic/2026-08-31/12-36-13_d1584/13-41-14.686Z_573f5.json` (`received.summary.errorFrames[0]`, `received.summary.payload.choices[0]`), and the same pattern in `13-36-28.878Z_3a30a`, `13-36-30.834Z_ee329` (see `docs/research/upstream-error-at-capacity-retry-analysis.md` § "What the wire actually looked like").
- **Adapter yields too early:** `source/providers/ai-sdk-streamed-model.ts:79-81` (`text-delta → yield {type:'text_delta'}`) and `source/providers/openai-chat-completions-model.ts:110-112` (`delta.content → yield text_delta`) emit the `" "` immediately. For the AI-SDK lane the very next `part` is `type:'error'` which `ai-sdk-streamed-model.ts:187` re-throws — but by then the turn has already yielded.
- **Transport retry is then blocked by design:** `source/providers/retrying-model.ts:82-92` sets `committed=true` after *any* `yield` (line 86) and `catch` refuses retry when `committed` (line 91) — invariant: "can't un-show content / un-run a side effect." Every occurrence logged `retry.model_transport_exhausted attempts:1` (zero retries); classification was not the bug — `classifyUpstreamRetryableError` (`source/services/retry/upstream-retry-policy.ts:122-130, 145-151`) correctly returns `retryable:true` for `502`/`429`/`>=500`.
- **Why the proposed "just don't yield / treat as pre-commit" is high-risk:** see §3. It couples SSE look-ahead to the commit contract every caller depends on (UI, persistence, tool-loop, billing, cancellation, `include-human` eval). The safe variant keeps the contract intact and narrows the change to a 1-element peek buffer for *trivial* whitespace only, gated by `retryable` and behind a flag with targeted tests.

## 1. Evidence — traced end to end

### 1.1 Wire

```json
// from 13-41-14.686Z_573f5.json (received.summary)
"transport": "sse", "status": 200,
"errorFrames": [{ "choices":[], "error":{ "code":502, "message":"Upstream error from OpenInference: Model is at capacity", "metadata":{"error_type":"provider_unavailable"}}}],
"payload": { "choices":[{"finish_reason":"error","delta":{"content":" "}}], "usage":{...} }
```

Summarizer correctly routes `parsed.error` to `errorFrames` (`source/services/logging/provider-traffic.ts:502-504`) — but **runtime adapters do not share that gate**; they yield the delta first (next section).

Duplicate across 5 requests that day: `12-36-13_d1584/{13-36-28,13-36-30,13-41-14}`, `13-27-22_52418/{13-36-28,13-36-31}` (`docs/research/upstream-error-at-capacity-retry-analysis.md`). Files `12-36-15_cf6a1` / `14-30-18_0fc54` containing "at capacity" are request-history echoes, not failures.

### 1.2 Adapter — where `" "` is yielded

**AI SDK lane (OpenRouter/deepseek path that failed):**

- `ai-sdk-streamed-model.ts:79-81` — `text-delta → yield text_delta` with no buffering.
- `ai-sdk-streamed-model.ts:187` — `if (part.type==='error') throw part.error` — thrown *after* the previous yield.
- `ai-sdk-streamed-model.ts:158-189` — `finish` handling requires authoritative `finishReason`; `error` is a separate branch.

**Chat Completions lane (generic OpenAI-compatible):**

- `openai-chat-completions-model.ts:75-112` — iterates `for await (const chunk of response)`, accumulates `delta.content` and `yield`s it immediately; never checks `chunk.error`. `sawFinishReason` captures `choice.finish_reason` (`:78-80`) so `finish_reason:"error"` still counts as "saw finish" and the final `if (!sawFinishReason) throw` (`:143`) is *not* triggered — the turn would complete with `finishReason:"error"` rather than throw, hiding the error shape variance. That lane has a second failure mode to handle.

Both lanes treat the one-space delta as ordinary content.

### 1.3 RetryingModel commit gate

```ts
// source/providers/retrying-model.ts:81-97
async *stream(request) {
  for (let attempt=0;; attempt++) {
    let committed=false;
    try {
      for await (const event of this.model.stream(request)) {
        committed=true; // line 86 — any yield commits
        yield event;
      }
      return;
    } catch (error) {
      if (committed || !this.#canRetry(error, attempt)) { // line 91
        this.#logExhaustion(error, attempt);
        throw error;
      }
      await this.#backoff(...);
    }
  }
}
#isRetryable = isNetworkProtocolError || classifyUpstreamRetryableError(...).retryable // :145-147
```

Tests codify the invariant (`source/providers/retrying-model.test.ts:76-93` "does not retry after an event commits"; `59-74` "retries only before first event"). Upstream classification (`upstream-retry-policy.ts:122-151`) marks `OpenRouterError status 502 → retryable:true, status 429/>=500 → retryable`.

### 1.4 The other two retry layers (why only transport mattered here)

- `source/services/retry/in-loop-model-retry.ts:58-146` — `classifyInLoopModelRetry` computes `upstream=classifyUpstreamRetryableError(error)` (`:89`) and `upstreamDelay` (`:90`) but **never reads `upstream.retryable`** for the decision; final `return {retryable:false, reason:'unrecoverable'}` (`:146`) makes 502 unretryable in-loop. It only retries `previous_response_not_found`, websocket close codes `1001/1006/1011/1012/1013`, `AmbiguousModelOutcomeError+isRecoverableIncompleteStreamClose`, `websocket_connection_limit_reached`, and string connection drops.
- `source/services/session/turn-workflow.ts` + `initial-turn-recovery-handler.ts` / `continuation-recovery-handler.ts` — did retry at turn boundaries: `retry.transient` at 20:36:30/32 (attempt 1/2, 2) then success 20:38:25. Correlation `c1b590b3` at 20:41:16 logged **zero** `retry.transient` and **zero** `stream.failed` — proves recovery handlers were never in the path. `conversation-orchestrator.ts:830` surfaced the error. Failing `requestId 573f5` had `inputItems:37` — a tool-continuation after `activate_skill` inside `ApplicationRunLoop`'s internal loop.

Intermediate fix `bd4186e7 "reset transient retry budget once a stream commits"` was reverted by `b18f3674` per `project` memory `at-capacity-retry-bypass` — it was based on wrong premise (budget exhaustion; stream.failed never fired). Evidence for revert retained in git log.

## 2. Why the root fix is correct but high-risk

The note in the task is accurate. Touching `yield → committed` changes a contract every provider, UI flush, persistence, tool-loop, billing, cancel/timeout, and eval path depends on:

1. **Blast radius = all streaming.** Commit is not a helper flag; it is the definition of "safe to retry." Changing "what counts as content" from `>0 bytes yielded` to `>0 bytes unless next frame is error` couples parser look-ahead to retry policy. Providers emit whitespace/ping frames differently (keep-alive `:`, `role` announcements `:106-112` in chat model, `reasoning_content` vs `reasoning`) — latent formatting regressions (dropped leading space, truncated tool args, duplicate tokens on retry) hide until a provider changes its framing.
2. **Observability / user-visible content violation.** Once yielded, content may be rendered, persisted, and included in token accounting. Buffering delays TTFT; a buggy buffer drops/truncates or duplicates. The current `committed` is synchronous and obvious; a peek-ahead buffer is stateful and timing-sensitive (SSE batch boundaries, `[DONE]` handling `provider-traffic.ts:460`, OpenRouter middleware `openai-compatible-response-normalizer.ts` cost trailer interception).
3. **Idempotency / retry-storm risk.** Treating in-band errors as `transient/pre-commit` assumes retryable. A non-retryable `invalid_request`/`401`/`429 long retry-after >60s` (`upstream-retry-policy.ts:91-94,97-99`, `retry-error-classification.ts` `LongRetryDelayError`) arriving in-band would then loop and burn quota/cost. Gate must be `classifyUpstreamRetryableError(error).retryable === true` *and* `retryAfterMs <=60s` — not just "error field present."
4. **Protocol leakage / spec variance.** In-band shape differs per lane: AI-SDK `part.type==='error'` with `part.error` carrying `status/code`, Chat Completions `chunk.error` or `choices[0].finish_reason==="error"` plus `delta.content:" "`, Responses WS `response.failed` with `error.code`. Narrow fix over-matches (retry non-retryable) or under-matches (miss next provider's spelling). Logging summarizer (`provider-traffic.ts:502`) already distinguishes `errorFrames` vs `malformedFrames` vs `unknownFrames` — runtime must not invent a fourth interpretation.
5. **Verification cost is dominated by non-determinism.** Frame interleaving (whitespace and error in same `data:` block vs adjacent blocks `provider-traffic.ts:454-460`), tool-call deltas (`calls Map` keyed by `index`), and retry backoff (`computeUpstreamRetryDelayMs`) require matrix tests across providers and transports.

Lower-risk patch `classifyInLoopModelRetry: consult upstream.retryable for non-chained requests` leaves commit untouched and is thus smaller, but it is **not** the root fix (still relies on a later retry layer and on `previousResponseId` anchoring). Root fix is warranted — but must be staged.

## 3. Safe approach — principles

1. **Narrowest yield suppression:** Only suppress *trivial* leading whitespace (`isTrivialWhitespace`) that is the *only* content yielded so far and is immediately followed by an in-band error *without any intervening material delta*. Definition: `text.trim().length===0 && text.length<=4` (covers `" "`, `"\n"`, `""`; tune after scanning provider-traffic history). Any `tool_call_streaming_delta`, non-whitespace `text_delta`, or `reasoning_delta` before the error → not trivial → committed stays true (user-visible work already happened).
2. **Retryable-gated:** Only treat suppressed case as retry-eligible when `classifyUpstreamRetryableError(inBandError).retryable===true` (and `retryAfterMs` respects the `>60s` long-delay refusal). Otherwise surface immediately — do not spin.
3. **Minimal buffering, single-element look-ahead:** Do not introduce a streaming delay queue. Buffer at most one pending trivial delta; flush-or-discard on the very next meaningful part (`error`, `finish`, material delta). This bounds latency to one SSE frame (microseconds) and keeps state machine auditable.
4. **Keep `RetryingModel` invariant pure in phase 1:** Fix the *producer* (adapter), not the *commit gate*. `RetryingModel.committed` stays `any yield → committed`. No second meaning of "committed but retryable anyway." If adapter did its job, RetryingModel never sees the trivial yield, so no retry is needed. This halves blast radius (only the two adapters change, not every stream).
5. **Feature-flag + metrics + exhaustive tests:** Flag off by default, per-session opt-in, with counters: `retry.suppressed_trivial_before_error`, `retry.in_band_error_retryable`, `retry.model_transport` (already exists). Require before/after traffic fixtures.

## 4. Recommended staged implementation

### Phase 1 (this fix) — adapter peek buffer, no RetryingModel change

**Scope:** `source/providers/ai-sdk-streamed-model.ts` and `source/providers/openai-chat-completions-model.ts` only. Leave `RetryingModel`, `in-loop-model-retry`, turn recovery untouched.

**Behavior:**

```
// ai-sdk-streamed-model.ts stream loop (pseudocode for review)
let pendingTrivial: string | null = null;
let hasMaterial = false;
for await (const part of result.stream) {
  if (part.type === 'text-delta' && isTrivialWhitespace(part.delta) && !hasMaterial) {
    pendingTrivial = part.delta; // hold, do not yield yet
    continue;
  }
  if (part.type === 'error') {
    const err = part.error;
    // discard pending trivial before classifying; do not yield it
    pendingTrivial = null;
    // only retryable-gated suppression matters to caller; still throw here
    // RetryingModel will see no prior yield → eligible to retry if retryable
    throw err;
  }
  // any material part flushes pending
  if (pendingTrivial !== null) {
    appendText(output, pendingTrivial);
    yield {type:'text_delta', text: pendingTrivial};
    hasMaterial = true;
    pendingTrivial = null;
  }
  // ... existing branches, setting hasMaterial=true on material yields ...
  if (part.type === 'finish') {
    // if pending trivial still held and finish is stop/length/tool_calls → flush it (it was real leading space)
    // if finish is error-like without throw, handling below applies
  }
}
```

- `isTrivialWhitespace(s:string) = s.length>0 && s.length<=4 && s.trim()===""`
- `hasMaterial` flips on any `text_delta` non-trivial, `tool_call_streaming_delta`, `reasoning_delta`, `tool-call`. Keep simple: only the *first* chunk(s) are eligible to be held; after material, trivial whitespace is real inter-word spacing and must not be suppressed.
- On `finish` with `finishReason.unified==='other' && raw==null` the adapter already throws (`:159-160`); pending trivial should be discarded before throw if finish is error-like — but this path is not the incident's path.
- On normal `return`/`finish` with `unified:'stop'|'tool_calls'` and a held `pendingTrivial`, flush it as real content (e.g., API legitimately starts with a space).

**Chat Completions lane:**

```ts
// openai-chat-completions-model.ts — same idea, but check chunk.error
for await (const chunk of response) {
  if ((chunk as any).error) {
    if (pendingTrivial) pendingTrivial = null;
    throw normalizeUpstreamError((chunk as any).error); // must be classified retryable
  }
  // detect trivial delta.content
  const trivial = choice?.delta?.content && isTrivialWhitespace(choice.delta.content) && !hasMaterial;
  if (trivial) { pendingTrivial = choice.delta.content; continue; }
  // ... existing reasoning/tool_calls/finish handling, flushing pending on material ...
}
if (pendingTrivial && sawFinishReason && finishReason!=="error") {
  // flush leading space on successful completion
}
```

`normalizeUpstreamError` should produce an `OpenRouterError`/`OpenAICompatibleError` with `status = error.code ?? 502` so `classifyUpstreamRetryableError` sees it. Today `openai-chat-completions-model.ts` would not throw at all for in-band `error` — this is a correctness fix independent of whitespace.

**Flag:** `agent.experimentalSuppressTrivialWhitespaceBeforeInBandError` (default false) or env `TERM2_SUPPRESS_TRIVIAL_WS=1`. When off, `isTrivialWhitespace` still runs but never holds — immediate yield, preserving current behavior for comparison.

**Tests to add (must pass before flag on):**

- `ai-sdk-streamed-model.test.ts`: (a) `" " → error(502)` yields zero events and throws 502 (retryable); (b) `" " → error(400 invalid_request)` yields zero events and throws non-retryable; (c) `" " → "hello"` yields `" hello"` (space preserved); (d) `"hello" → " " → error` yields `"hello"` before throw (already committed — RetryingModel must not retry, verify single attempt); (e) `"\n" → error` same as (a); (f) tool delta before `" " → error` → committed.
- `openai-chat-completions-model.test.ts`: same matrix via `chunk.error` and `finish_reason:"error"` shapes.
- `retrying-model.test.ts`: new case "does not commit on suppressed trivial whitespace" — underlying stream holds `" "` via adapter would throw without prior yield; verify `RetryingModel` retries (attempts 2) when adapter correctly suppresses; also verify `"x" then error` does NOT retry.
- `provider-traffic.test.ts`: fixture with `data: {"choices":[{"delta":{"content":" "},"finish_reason":"error"}]}` + `data: {"error":{"code":502,...}}` parses to `errorFrames:1, payload.finish_reason:"error"`; plus regression for `chunk.error` shape.
- Black-box: `scripts/provider-black-box/fake-provider-http-server.ts` SSE handler sending `data: {"choices":[{"delta":{"content":" "}}]}\n\ndata: {"error":{"code":502,...}}\n\n` and assert `RetryingModel` retries to success on second attempt.

### Phase 2 (only if Phase 1 proves insufficient) — RetryingModel trivial-commit carve-out

If another provider/transport emits trivial whitespace *outside* the two adapters (e.g., Responses WS `output_text.delta:" "` before `response.failed`), add a second guard in `RetryingModel`:

```ts
// RetryingModel — only if Phase 1 missed a path
type CommitKind = 'none' | 'trivial' | 'material';
let commitKind: CommitKind = 'none';
for await (const e of this.model.stream(request)) {
  if (e.type==='text_delta' && isTrivialWhitespace(e.text) && commitKind==='none') commitKind='trivial';
  else commitKind='material';
  yield e;
}
// in catch:
const isInBandRetryable = isInBandError(error) && classifyUpstreamRetryableError(error).retryable;
if (commitKind==='trivial' && isInBandRetryable) {
  // allow retry as if not committed; do not yield the trivial downstream
  // requires adapter to have not already yielded it — otherwise user already saw it
}
```

This is **deferred** because it reintroduces commit-semantics complexity and requires `isInBandError` discrimination (AI-SDK `error`, chat `error/code`, WS `response.failed`). Prefer to keep it out until Phase 1 traffic shows residual misses.

### Why not fix `classifyInLoopModelRetry` as the root fix?

Consulting `upstream.retryable` there (`in-loop-model-retry.ts:89` compute but don't use `upstream.retryable`) would let the run-loop retry tool-continuations (the 20:41:16 failure). That is a valid *layer-2* fix and low-blast-radius (session-scoped, no streaming contract change). It is complementary, not alternative: it still requires a committed-stream definition, and it retries *after* material content may have been produced (requires `previousResponseId` clearing and history rebuild). Keep it as a separate, independently flag-gated change `fix(in-loop): consult upstream.retryable for non-chained 5xx/429`.

## 5. What to verify before enabling by default

- Run `pnpm test:related` for `retrying-model`, `ai-sdk-streamed-model`, `openai-chat-completions-model`, `provider-traffic` — plus `pnpm test:provider-black-box` (19 files/171 tests baseline clean on that date per explorer).
- Add traffic-fixture corpus from the 5 real failure logs (redacted) and assert suppressed path.
- Canary with flag on for one internal session, confirm `retry.model_transport` fires for 502 after trivial, `retry.model_transport_exhausted` no longer `attempts:1` for that shape, and no `" "` flash in UI.
- Confirm no regression for normal leading-space completions: sample provider-traffic payloads where first delta is `" "` followed by substantive text and `finish_reason:"stop"` (not error) still render the space.

## 6. Risks even with the safe approach

- Over-broad trivial definition suppresses intentional leading space (e.g., code generation starting with indentation). Mitigation: only suppress when *next* meaningful part is `error`; flush on `stop/tool_calls`.
- Generic whitespace (`"\n\n"`) before error could be non-trivial formatting; still safe to discard because error means no valid completion, but confirm no provider legitimately sends newline then error as "partial success."
- Chat completions lane error shape variance (`error` top-level vs `choices[0].finish_reason:"error"` plus `delta`) — fix must handle both; incomplete handling leaves one lane still committed.

## 7. Sources (primary)

- `source/providers/retrying-model.ts:81-97,145-147` — commit gate and retryability.
- `source/providers/retrying-model.test.ts:59-93` — committed invariant tests.
- `source/providers/ai-sdk-streamed-model.ts:79-81,158-189` — text-delta yield and error throw.
- `source/providers/openai-chat-completions-model.ts:75-143` — chat streaming loop, finish_reason handling, no `chunk.error` check.
- `source/services/retry/upstream-retry-policy.ts:90-183` — `classifyUpstreamRetryableError` (502/429/>=500 retryable, `retryAfterMs`, long-delay refusal).
- `source/services/retry/in-loop-model-retry.ts:58-146` — computes but ignores `upstream.retryable`.
- `source/services/retry/retry-error-classification.ts:363-389` — `LongRetryDelayError` etc., `isNetworkProtocolError`.
- `source/services/logging/provider-traffic.ts:450-504,502` — `errorFrames` collection on `parsed.error`.
- `source/services/logging/provider-traffic.test.ts:338-341` — errorFrames expectations.
- `~/.local/state/term2-nodejs/logs/provider-traffic/2026-08-31/12-36-13_d1584/13-41-14.686Z_573f5.json` (and `13-36-28.878Z_3a30a`, `13-36-30.834Z_ee329`, `13-27-22_52418/13-36-28.537Z_6f4d8`, `13-36-31.016Z_83e56`) — wire proof.
- `docs/research/upstream-error-at-capacity-retry-analysis.md` — incident diagnosis (no code changed).
- `source/providers/openai-compatible-response-normalizer.ts:10-41` — cost/trailer SSE normalization (adjacent framing edge).
- Git log: `bd4186e7` / `b18f3674` revert, `462c697d` docs commit.
- Memory `at-capacity-retry-bypass` (`project` scope, 2026-08-31T16:34:56Z) — correct cause is in-loop bypass, not turn-level budget.

## 8. Open questions for implementation review

1. Should suppression window be exactly one trivial delta or coalesce consecutive trivial deltas (`" " + "\n"`) before error? Recommend coalesce while `!hasMaterial` and total buffered length <=4.
2. For Responses/WS lanes (`openai-responses-model.ts`, `codex-responses-model.ts`) — do they exhibit the same leading-space-before-`response.failed`? Scan traffic `wireShape:"responses"` error frames before adding phase-2 guard.
3. Flag lifetime: remove after one release once provider-traffic shows zero residual `commit-then-error` for trivial case, or keep as kill-switch?
