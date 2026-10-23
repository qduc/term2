# TurnWorkflow internals

`source/services/session/turn-workflow.ts` (~1090 lines). Verified against source on 2026-08-02.

The single largest file on the foreground turn path. `TurnCoordinator` calls into it
and sees a clean `TurnOutcome`; everything messy about retries, approval hand-offs,
and post-execute gates lives here. Read this before adding a branch to it.

## The one idea that explains the file

There are **two outcome types**, and the difference is the whole design:

```ts
TurnOutcome          // what TurnCoordinator sees — response | approval_required | stale | failed
InternalTurnOutcome  // adds 3 variants that must never escape this class
```

The three internal-only variants (`turn-workflow.ts:20`) are each a request for the
workflow to **re-enter itself**:

| Internal variant | Means | Handled by |
| --- | --- | --- |
| `fresh_start_required` | this attempt is unusable; rebuild input from history and re-drive | `#replayFromFreshStart` → back into `executeInitial` |
| `abort_resolution_required` | user hit Esc on an approval, then typed something; the abandoned tool call must be settled before the new text can be a normal turn | `executeContinuationAttempt({kind:'abort_resolution'})` |
| `auto_approval_required` | the LLM/policy approved a shell command; the run must be resumed as if the user had answered `y` | `executeContinuationAttempt({kind:'approval_decision', answer:'y'})` |

So the public methods are **trampolines** and the `*Attempt` methods are the real work:

```
executeInitial          (loop)  ──drives──> executeInitialAttempt        (loop)
executeContinuation     (loop)  ──drives──> executeContinuationAttempt   (loop)
```

Both trampolines exist only to catch an internal variant and re-dispatch. Nesting is
bounded in practice but **not structurally** — there is no depth counter on the
`fresh_start_required` cycle; the retry counts carried in `RetryCounts` are what
actually terminate it. If you add a new internal variant, you are adding a new way for
that loop to spin.

## Layout

| Region | Lines | What |
| --- | --- | --- |
| `InternalTurnOutcome` | 20–37 | the seven-variant union above |
| `TurnWorkflowDeps` | 71–98 | 20 injected collaborators — the real complexity metric for this class |
| Trampolines | 120–213 | `executeInitial`, `executeContinuation`, `continuePostExecute`, `#replayFromFreshStart` |
| Initial path | 215–650 | `executeInitialAttempt` + stream cycle + `LiveRun` plumbing + `#startInitialStream` |
| Continuation path | 652–1001 | `executeContinuationAttempt` + batch approvals + recovery + stream cycle |
| Helpers | 1003–1092 | call-id resolution, response building, live-run abort |

## The initial path

`executeInitialAttempt` (215) is one `while (true)` whose iterations are **retries**,
not turns. Each pass:

1. **Staleness check** (262–272). Two variants depending on whether an aborted-approval
   context is in play. `GenerationGuard.isCurrent(token)` is checked at six separate
   points in this file — every `await` boundary is a place the user could have hit Esc.
2. **Aborted-approval bail-out** (275–296). Returns `abort_resolution_required`.
3. **Input prep** via `InitialInputPreparer` (298). `blocked` yields an event and fails.
4. **`#executeInitialStreamCycle`** (403) — see below.
5. **Recovery** (367–393) via `InitialTurnRecoveryHandler`, which decides `run` (loop
   again with mutated options), `stale`, or rethrow.

### LiveRun: why the stream isn't consumed inline

`#executeInitialStreamCycle` does not iterate the stream directly. It wraps consumption
in a `LiveRun` (`session/live-run.ts`) and then *drains* it (`#drainLiveRun`, 447).

The reason is **post-execute approval gates**. A tool can run, then pause awaiting
approval before its result is committed. At that moment the run loop is parked inside a
tool promise, but the workflow must return `approval_required` all the way to the UI —
without tearing down the stream that is still holding the tool open.

`LiveRun` is that ownership boundary: it starts the consumer exactly once, buffers
events, and lets `next()` report `event` / `post_execute_approval_required` /
`completed` / `cancelled`. `#liveRun` survives the return, and
`continuePostExecute()` re-attaches to the *same* run later.

Two consequences that trip people up:

- **`attempt.close()` ownership is conditional.** The `finally` at line 399 checks
  `#liveAttemptOwners` (a `WeakSet`): if a live run took ownership, the attempt is
  closed by the `LiveRun` consumer's own `finally` (436–439) instead. Closing in both
  places would detach abort handling while a tool is still parked.
- **`#liveRun = null` is written in five places.** Every exit from `#drainLiveRun`
  plus `abortLiveRun` and the `#continuePostExecuteRun` catch. Each also clears
  `setActivePostExecuteRunId`. Miss one and the next turn thinks a run is still live.

### Provider continuity (`#startInitialStream`, 580)

Picks `previousResponseId` and attaches `providerHistorySnapshot`. Note the
`Object.defineProperty(..., {enumerable: lineage !== 0})` trick used twice (594, 636) —
the lineage field is deliberately hidden from enumeration when zero so it doesn't
appear in serialized request options.

Lines 604–630 are an **equality-gated ownership handoff** for OpenAI root-checkpoint
parity: a checkpoint may only become the selector once it has proved it produces the
identical ID the legacy selector would have sent. Any mismatch, ineligibility, or thrown
error silently retains legacy selection. The `catch {}` there is intentional — parity
observation must never alter the request path.

## The continuation path

`executeContinuationAttempt` (652) is the other `while (true)`. Per pass:

1. Staleness check (670).
2. **`#stagePendingParallelApprovals`** (770) — delegates to
   `ToolApprovalBatchCoordinator`. This is what makes parallel tool calls surface as one
   approval batch rather than N sequential prompts.
3. **`#executeContinuationStreamCycle`** (914) — resumes via
   `agentClient.continueRunStream`, then threads four cumulative accumulators
   (`usage`, `commandMessages`, `turnItems`, `emittedIds`) forward. `ContinuationState`
   holds them across passes; they exist because one logical turn can span many streams
   and the UI must see the union, not the last segment.
4. **`#handleApprovalOutcome`** (826) returns `return` / `loop` / `continue`. The
   `loop` case applies the next plan and recomputes `state.currentCallIds`.
5. **Recovery** (732) → `resume` (loop), `stale`, `fresh_start`, or rethrow.

### Call-id resolution

`#activeCallIdsForInit` / `resolveResponseCycleCallIds` / `resolveAbortedApprovalCallIds`
(`continuation-call-id-resolver.ts`) exist because the provider must receive tool-result
IDs that exactly match the calls it is waiting on. Aborted-approval and normal-response
cycles resolve them differently. This is the most common source of
"provider rejected the continuation" bugs — if you touch it, the black-box suite is
mandatory, not optional.

## Where to add things

- **New retry/recovery reason** → `InitialTurnRecoveryHandler` /
  `ContinuationRecoveryHandler`, not here. This file only dispatches on their verdict.
- **New approval policy** → `services/approval/`. `TurnWorkflow` calls
  `policy.decide()`; it should not learn new decision rules.
- **New terminal shape** → `conversation-result-builder.ts`.
- **A new internal outcome variant** → think hard. Each one adds a re-entry edge to a
  trampoline that has no depth bound.

## Known rough edges

- **`any` at the outcome boundary.** `outcome: any` appears 8 times (lines 103, 412,
  430, 448, 451, 491, 827, 919), plus `nextPlan: any` and three `: any` option bags. The
  union coming out of `buildConversationResult` is not typed here, so variant handling
  is unchecked. This is the highest-value typing fix in the file.
- **`#handleApprovalOutcome` returns three actions but only two are produced.**
  `{action:'continue'}` is declared (835) and never returned.
- **Duplicated auto-approve logging.** Lines 326–347 and 839–861 are near-identical
  blocks in the initial and continuation paths.
- **`#freshStartReplayOptions` is bypassed by its own caller.** `executeInitial`
  inlines the same option object (161–169) rather than calling the helper (194).
