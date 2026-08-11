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
