# Independent verification evidence

Verifier: separate agent that made no production edits. Baseline: `844a62c4`.
The inspected production diff (`git diff 844a62c4 -- source | sha256sum`) was
`3add3c29bc36a185e35a12e0e13a290474fa0d4d4b2fa7e26c63e2f49f845ec5`.
Verdict: **accept**. The final production diff hash remained unchanged through
the focused probes and the implementing agent's completed final suite runs.

## Independent checks

Temporary probes used the actual session composition, Record, approval flow,
plan applier, lifecycle, and provider continuity. The retained-decision probes
substituted the external `ConversationAgentClient.runTurn` boundary with a driver
that invoked the real prepare/consume/accept/interrupted/completed callbacks.
They did not instantiate the physical provider run loop.

Each command below ran from the worktree with exit code 0 after the final
production revision notice. The scripts lived outside the repository under
`/tmp` and were removed after recording these results; no permanent tests were added.

| Command | Observed assertions |
| --- | --- |
| `pnpm exec tsx /tmp/session-boundaries-verifier.mts` | First current decision advanced from interruption `one` to `two` in the same generation. Wrong generation, replayed first answer, and structurally cloned second address rejected without consuming the wait. A fresh exact second answer succeeded; precisely two approvals. |
| `pnpm exec tsx /tmp/session-boundaries-record-verifier.mts` | Real filesystem journal sink wrote an event then threw. Receipt reported `accepted: memory`, `persistence: failed`; completed effect remained in ledger/history and survived decision-baseline `retry_fresh` recovery. Terminal response ID was `resp-terminal`, with empty tool debt. |
| `pnpm exec tsx /tmp/session-boundaries-lifecycle-verifier.mts` | Empty undo/retry, zero/negative undo count, and invalid rewind produced zero generation/reset, revision, or undo-log changes. Retry retained exact imported provider input, incremented generation once, logged once. Invalid import preserved history and generation; successful undo logged once. |
| `pnpm exec tsx /tmp/session-boundaries-cancel-verifier.mts` | Undo while an actual retained approval wait was pending retired that wait. Old answer rejected, user turn removed, approvals remained zero. |
| `pnpm exec tsx /tmp/session-boundaries-continuity-verifier.mts` | Partial acceptance kept checkpoint candidate, published response identity and unpaid `one`. Terminal acceptance promoted the candidate, retained authoritative history proof, and cleared debt. Throwing diagnostic observer did not reject accepted state. |
| `pnpm exec tsx /tmp/session-boundaries-request-verifier.mts` | 28 parity cases matched prior inline behavior: previous-response selection; lineage value, enumerability and descriptors; debt-based new-turn eligibility and clearing. |

The retained-decision check first demonstrated the defect before the address
check: replaying the identical first init while the second wait was active
returned a response and approved interruption `two` (`approved: 2`,
`secondResolved: true`). The same driver then demonstrated rejection and a
successful fresh answer after the correction. A generation check alone would
not have distinguished these two waits.

## Inspection

- `TurnProjectionState` and `PreparedContinuation` no longer retain runtime
  handles, continuation call-ID sets, response IDs, or journal baselines.
- Record privately selects persistence timing and owns recovery baselines.
  `SessionTurnAdapter` no longer publishes checkpoints or updates tool debt.
- `ProviderContinuity.acceptSegment` incorporates history/response/debt evidence
  synchronously before its diagnostic callback. Request decoration moved into
  the existing continuity owner without adding another execution loop.
- `SessionLifecycle` incorporates complete history operations; external callers
  no longer pair mutations with a separate cleanup/logging call. Public
  `SessionState` exposes the intended state operations through a narrowed type.
- Presentation caches stay in `SessionToolTracker` across decision waits;
  approval contexts/plans no longer carry saved argument maps for restoration.
- `executeContinuation` checks exact runtime interruption identity and generation
  before consuming the pending wait. It leaves a rejected answer's wait intact.

## Limits and inherited behavior

The focused probes do not establish physical tool dispatch counts, live-provider
transport behavior, or crash durability/fsync. The implementing
agent's provider black-box/e2e results supply broader workflow evidence; they
do not establish every real-provider or physical-environment behavior. The filesystem
fault check establishes in-process retained effect evidence and recovery, not
process-crash recovery. Cache retention was inspected; full rendered behavior
requires the broader suites.

`ConversationStore.removeAfterLastToolOutput` already treats a final result with
an empty trailing tail as an accepted retry (revision and lifecycle reset).
That inherited behavior was identified separately and left unchanged; the
no-op checks above cover empty/invalid user-turn and rewind operations.


## Final suite disposition

The implementing agent ran the following final suites. The verifier inspected
these output files and confirmed the production diff hash above remained
unchanged:

| Suite | Final result | Inspected log |
| --- | --- | --- |
| Integration | 121 passed, one existing skip; 79.38 seconds | `/tmp/term2-session-boundaries-integration-final.log` |
| Provider black-box, isolated final run | 204 passed, one existing skip; 77.60 seconds | `/tmp/term2-session-boundaries-provider-serial.log` |
| E2e | 31 passed; 4.56 seconds | `/tmp/term2-session-boundaries-e2e-final.log` |
| Static checks | 28 passed | `/tmp/term2-session-boundaries-static-final.log` |
| Lint and formatting | Zero errors, 31 warnings; formatting passed | `/tmp/term2-session-boundaries-lint-final.log` |

The implementing agent also reported successful typecheck and the permanent-unit-test
policy check. The initial concurrent final provider run failed because the
OpenRouter early-close child exceeded its timeout. The isolated full provider
rerun passed without changing production code or tests. This evidence supports
an execution-resource explanation; it does not prove the original timeout's
cause.

No remaining evidence-backed regression was found in the final diff. The saved
internal-decision defect found during verification was corrected and received
red/green evidence. The verdict is scoped to this refactor and these workflows;
it is not a claim that arbitrary raw continuation-handle callers or all
live-provider transports have been verified.
