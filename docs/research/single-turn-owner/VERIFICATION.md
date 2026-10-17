# Independent verification of one turn owner

Verified in the `codex/single-turn-owner` worktree against baseline `f2a9ec8a`. The inspected source is identified by [the SHA256 manifest](evidence/source-sha256.txt). This report records a bounded verification run, not a claim that every provider or interactive terminal behavior was exercised.

## Architectural verdict

The foreground session now has one execution owner: `ApplicationRunLoop.#runTurn`. It prepares the initial state, asks the model, records the response, dispatches tools, waits for decisions, and decides whether a recovery starts another attempt. `SessionTurnAdapter` supplies bounded preparation, projection, decision, and recovery operations. Its public continuation methods answer or observe the existing computation; they do not dispatch another runtime stream. `LiveRun` buffers observation and exposes pending gates. The legacy native start/continue API remains for nested clients and uses the same model/tool loop.

This removes execution ownership from the deleted `TurnWorkflow`; it is more than a rename. There are still policy loops over approval batches and stream-projection loops. Those do not decide the next model execution.

## Evidence collected independently

- Baseline built CLI question scenario: **1 passed**. The new permanent `turn-decisions.blackbox.ts` scenario exercises answering an `ask_user`, cancelling a later question, starting a successor, and preserving the cancelled question result in persisted conversation history.
- Built CLI matrix after the ownership change: **74 passed, 1 skipped**, across conversation-loop, question decisions, provider-session resilience, Responses continuity, and nested-hide scenarios. This includes queued message edit/retract/release, repeated manual approval, stop/successor, provider errors and partial responses, chain rebuilding, completed tool pair retention without redispatch, restart, compaction, and background shell completion. This matrix preceded the final lifecycle fixes; the implementer's final rebuilt matrix supplies final-build coverage.
- Final source probes through real `AgentClient` and `createSessionRuntime`: **4 passed**. Only the external model transport was replaced by a controlled fixture. The probes cover abandonment while streaming; abandonment during manual approval; manual approval followed by actual `PostExecutePauseCapability`/`PostExecutePendingRegistry`, a tool rerun with a filesystem effect, and model continuation; and cancellation 30ms into a real retry backoff. Cancellation settled within a 300ms test bound without dispatching the retry; a successor then completed.
- Mutation evidence for public observer cleanup: reverting only `TurnCoordinator.#forwardOwned` to its baseline delegation caused **both abandonment probes to fail**. During streaming the provider was not aborted; during approval the successor was rejected because the old turn remained active. Restoring the exact source backup made all three then-existing probes pass. No distribution files were changed for this experiment.

The temporary source probes were removed from executable source after use, in accordance with the repository experiment. Their full source and output remain under [evidence](evidence/verifier-probes.ts.txt). The permanent question scenario remains a provider black-box test.

## Findings and dispositions

| Finding | Resolution and evidence |
| --- | --- |
| Returning the public observer failed to close its delegated iterator; cancelling the observer mailbox could also leave an approval decision unresolved. | Route: delegate `return()` in a `finally`; abandonment calls `abortLiveRun`, rejects the pending decision, aborts the runtime, and awaits completion. Red/green mutation evidence and both abandonment probes demonstrate the boundary. |
| Continuation recovery termination swallowed the original error. | Route: restore throwing the original error when recovery terminates; inspected against the baseline continuation error route. |
| Accumulator reset had become unconditional. | Route: preserve the baseline reset predicate for initial/replay/retry inputs; inspected against baseline. |
| Stop-after-approval could be lost between batched approval waits. | Route: retain the flag through waits; inspected final runtime refresh logic. Existing built CLI question cancellation validates the normal single-question route. |
| Root adoption of an old live continuation handle would introduce competing execution ownership. | Narrow/remove: remove the unused root resume protocol and the recovery variant never emitted by `DefaultRecoveryPolicy`. Native nested start/continue remains supported. Production caller/policy search established the removed route was dormant. |
| Cancellation during session preparation/retry backoff lacked a live runtime signal and could permit later dispatch. | Route: a root lifetime controller spans preparation, recovery, approval, and views; segment replacement does not cancel that lifetime. `LiveRun` also refuses to invoke its consumer if cancelled before its startup microtask. Final real backoff probe verifies cancellation and successor admission. |

## Limits

The fixtures do not contact paid provider services. The post-execute probe uses the real capability, registry, approval composition, and filesystem effects with a custom tool; it does not exercise an operating-system sandbox denied-read prompt. The retained CLI matrix has the suite's existing WebSocket response-side reasoning skip because that route does not persist app-owned response traffic. Human comprehension itself was not measured. The final built distribution, integration matrix, static checks, and full provider matrix are recorded by the implementer separately.
