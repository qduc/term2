# Chain settlement

## Status

Implemented on branch `chain-settlement` (2026-08-11).

## The defect

After `Codex WebSocket closed before a terminal response event`, typing
`continue` produced:

```text
No tool output found for function call call_…
```

Root cause: terminate repaired **local** tool history but left
`previousResponseId` pointing at a response that still required tool outputs.
The next user turn used delta chaining and sent only the text `"continue"`.

## The invariant

If `previous_response_id` points at a response that issued function calls, the
next request must either supply every missing tool output, or drop that chain.

Mid-turn `continueRunStream` already honored this. Post-error user turns and
terminate recovery did not.

## What landed

| Area | Change |
| --- | --- |
| `ProviderContinuity` | Tracks `outstandingToolCallIds` (unpaid tool debt); cleared on `clear()` / `breakChaining()` |
| `SessionStreamProcessor.finalize` | Syncs debt from the tool ledger after terminal or partial commit |
| `DefaultRecoveryExecutor` terminate | Synthetic abort pairs when possible, then **always clears continuity** |
| `SessionInputPlanner.build` | If debt is open, clears chain and forces full-history input |
| Retry classification | Server “No tool output found for function call” → `transport_downgrade`; Codex/OpenAI “closed before a terminal response event” → incomplete-stream retryable |

## Premises

1. After a failed stream, **drop the chain** rather than try to push synthetic
   aborts into the dead server response. Server acceptance of the next request
   is ambiguous after a WebSocket death.
2. Mid-turn tool continuation is unchanged; it does not go through
   `SessionInputPlanner.build`.
3. Local history should still carry completed pairs and, when possible,
   synthetic abort pairs so full-history replay is self-contained.

## Checks

- Focused unit/session/retry suites: green (554 tests under
  `source/services/retry` + `source/services/session` + continuity).
- Provider black-box: chaining, approval resume, incomplete stream, and abnormal
  close scenarios for OpenAI/Codex green. Some PTY/first-run setup timeouts
  observed in the environment; not attributed to this change.

## Model-switch chain drop (2026-08-30)

A held `previousResponseId` is minted by whatever model produced it. Production logs showed a server 400 (`Invalid previous_response_id`) every time `agent.model` changed mid-session (e.g. `gpt-5.6-luna` -> `gpt-5.6-sol`), auto-recovered via `chain_recovery` but wasting a round trip each time.

`SessionInputPlanner` (`source/services/session/session-input-planner.ts`) tracks the model each turn actually dispatches to via `recordDispatchModel()` (called from `InitialInputPreparer.prepare()`, not from inside `build()` itself — `build()` must stay pure because `previewInputSurge()` calls it without dispatching) and drops chaining when the configured model no longer matches. Do not fold this tracking into `build()`.

## WebSocket Responses session persistence & chain settlement

WebSocket connections in `CodexResponsesTransport` and `OpenAIResponsesWSModelWithPromptCacheKey` are kept per logical agent (`providerHistoryKey`, else conversation `sessionId`) and stay open across that agent's completed turns so the backend retains in-memory `previous_response_id` state without requiring duplicate `generate: false` warmup requests. 

- Opening one agent's socket must not close another's connecting socket. Sockets close only on `close()`, stream failure, or cancellation. 
- When a 400 `Invalid previous_response_id` triggers `chain_recovery`, `breakChaining()` permanently sets `#chainingBroken` on that session's `ProviderContinuity` (`source/services/provider-continuity.ts` `#breakChaining`), so `SessionInputPlanner` builds full history for every later turn. 
- **Application layer vs Provider layer**: That is true of the *application* layer only. The Codex provider layer holds its own anchor in `#lastLogicalRequestByKey` (`source/providers/codex-responses-model.ts`), and that is what actually writes `previous_response_id` onto the wire. `disableChaining` is one-shot — the run loop clears it after a single attempt — and `#forgetCodexResponseId()` clears the anchor, but `#rememberCodexResponseId()` re-arms it (and resets `#serverHistoryReuseDisabled`) on the next response. So on the Codex lane a chain recovery yields one genuinely full-history request, after which the model re-anchors and trims the app's full history back to a delta. 
- A retry that omits `previous_response_id` must be self-contained full history. `ApplicationRunLoop` and `CodexResponsesWSModel` must not retry a caller-supplied chained delta without that anchor: the run loop only has the delta, and the Codex unchained fallback would send the same one-item input. Session recovery (`retry_fresh` + `full_history` + `disableChainingForAttempt`) is the path that actually has the transcript. (`codexPreviousResponseIds` looks like the anchor but is written and cleared and never read.)

