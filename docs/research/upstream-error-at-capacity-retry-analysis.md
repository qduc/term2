# Why "Upstream error from OpenInference: Model is at capacity" was not retried

**Date:** 2026-08-31 · **Type:** incident diagnosis (no code changed) · **Status:** analysis complete, fix not implemented

## Question

User saw `Error: Upstream error from OpenInference: Model is at capacity` surfaced in a
turn and asked why it was not retried.

## Evidence (all from real logs, 2026-08-31)

- Provider traffic: `~/.local/state/term2-nodejs/logs/provider-traffic/2026-08-31/`
  - 5 files carry a real in-band error frame (sessions `d15849ed` / `52418a69`):
    `12-36-13_d1584/{13-36-28.878Z,13-36-30.834Z,13-41-14.686Z}`, `13-27-22_52418/{13-36-28.537Z,13-36-31.016Z}`.
  - Files containing "at capacity" in `12-36-15_cf6a1` and `14-30-18_0fc54` are only
    request-history echoes of the user's pasted question — not failures.
- App logs: `~/.local/state/term2-nodejs/logs/term2-2026-08-31.log*`

## What the wire actually looked like

OpenInference returns **HTTP 200 + SSE** with the error **in-band**:

```json
"error": { "code": 502, "message": "Upstream error from OpenInference: Model is at capacity",
           "metadata": { "error_type": "provider_unavailable" } }
"choices": [{ "finish_reason": "error", "delta": { "content": " " } }]
```

The adapter yields the leading `" "` content chunk as a `text_delta` **before** the error
frame surfaces. That single yielded event is the crux of the retry behavior.

## The three retry layers and what each did

1. **Transport retry — `RetryingModel` (`source/providers/retrying-model.ts:91`)**
   refuses once any event was yielded (`committed=true`) — never replays a request whose
   response started streaming. Every occurrence logged
   `retry.model_transport_exhausted` with `attempts: 1` (zero transport retries). That log
   only fires when the error **is** retryable, so classification was not the problem:
   `classifyUpstreamRetryableError` sees `code: 502` → retryable.

2. **Run-loop in-loop retry — `classifyInLoopModelRetry`
   (`source/services/retry/in-loop-model-retry.ts`)**
   only retries chain-recovery patterns (bad `previous_response_id`, missing tool output,
   websocket close codes) and connection drops (socket hang up, ECONNRESET, ETIMEDOUT…).
   It computes `upstream.retryAfterMs` but **never consults `upstream.retryable`** for the
   decision. 502 "model at capacity" → `unrecoverable`.

3. **Turn-level recovery — `TurnWorkflow`'s `InitialTurnRecoveryHandler` /
   `ContinuationRecoveryHandler`** — this layer **did retry**: `retry.transient`
   at 20:36:30 (attempt 1/2, delay 513ms) and 20:36:32 (attempt 2/2, delay 1091ms);
   third attempt succeeded 20:38:25.

## Why the surfaced (20:41:16) failure was not retried

The failing request (`requestId 573f580c`, `inputItems: 37`) was a **tool-continuation**
(after `activate_skill`) running inside `ApplicationRunLoop`'s internal continuation loop.
Recovery handlers only wrap turn boundaries (initial turn / approval continuations), not
ordinary tool-call continuations. Log proof for correlation `c1b590b3`: **no
`retry.transient` and no `stream.failed`** (both recovery handlers log `stream.failed` on
termination) — the error bypassed the turn-level layer entirely and surfaced via
`conversation-orchestrator.ts:830` "Error in sendUserMessage" → `appendBotError`.

## Conclusion

- The error **is** classified retryable and **was** retried (twice) when it occurred at a
  turn boundary; 2 of 3 attempts still failed (upstream genuinely at capacity).
- The user-visible failure was a mid-turn tool-continuation, a point the retry
  architecture does not cover: transport retry can't (stream committed), in-loop retry
  doesn't (not a chain/connection pattern), turn-level recovery isn't in the path.

## Fix directions (not implemented — decide before acting)

1. `classifyInLoopModelRetry`: consult `classifyUpstreamRetryableError` and allow a
   chain-recovery / fresh-start retry for non-chained requests.
2. Route run-loop-internal continuation failures through the continuation recovery
   handler.
3. Root fix: don't yield the whitespace `" "` chunk when an error frame follows (or treat
   in-band SSE error frames as pre-commit in `RetryingModel`), so the transport layer can
   retry in-band errors.

## Relevant code

- `source/services/retry/upstream-retry-policy.ts` (`classifyUpstreamRetryableError`)
- `source/services/retry/in-loop-model-retry.ts` (`classifyInLoopModelRetry`)
- `source/providers/retrying-model.ts` (`committed` gate)
- `source/services/retry/retry-classifier.ts` (`DefaultRetryClassifier` — used by turn-level recovery)
- `source/services/session/initial-turn-recovery-handler.ts`, `continuation-recovery-handler.ts`
- `source/services/session/turn-workflow.ts` (recovery handlers wrap only turn boundaries)
- `source/services/conversation/conversation-orchestrator.ts:830` (surfacing)
