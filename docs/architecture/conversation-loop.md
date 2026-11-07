> **Archived — pre-rewrite runtime (removed in #197).** This document is historical
> design rationale, not the current execution contract. See [Architecture Overview](architecture-overview.md)
> and [layers](layers.md) for the single live path. Source snapshot: `e147c768f`.

# Execution and acceptance in a conversation turn

> **This runtime is not executed in production.** This page describes
> `ApplicationRunLoop` and the session runtime that `createSessionRuntime` builds
> (`src/session/session/`), driven by the legacy subagent runners in
> `src/delegation/subagents/`. Nothing constructs those runners, and the built bundle
> contains none of this code; deleting it is #197. Every conversation and child agent
> runs on `session/conversation-turn.ts` and `engine/turn.ts` instead; see
> [the overview](architecture-overview.md). Read this page for its design rationale, not
> as a description of live behavior. "Runtime session" below is the session
> `createSessionRuntime` builds, which this page called the root session before the
> rewrite (#86–#88).

Start with the [central flow](conversation-core.md). The legacy runtime's execution
owner is `ApplicationRunLoop.#runTurn`; the runtime session's acceptance owner is
`ConversationRecord`. These are distinct responsibilities: the loop decides
when another model/tool step runs, while Record decides which observed facts
become accepted conversation history and recovery evidence.

## The central control path

`#runTurn` awaits request preparation, model exchange and tool settlement in
sequence. `RunResponseRecorder.record` produces the requested tool plan. With no tool calls,
`#finishTurn` applies the existing completion policy and either finishes or makes
continuation explicit. Session recovery returns to this same loop.

```text
repeat:
    await builder.prepareBoundary()
    response = await exchange.askModel(build = builder.build)
    calls = recorder.record(response)
    await toolRound.execute(response, calls)
    if calls are empty and finishTurn() says done:
        return
```

This is an outline of control, not a complete execution recipe: budget exits,
approval interruption and cleanup remain in the implementation. Accepted items
are recorded synchronously as runtime events are produced, including during
model streaming and tool execution. Acceptance is not deferred until the
illustrative `recordResponse` step or presentation consumption.

| Boundary | Concrete symbols | Responsibility |
| --- | --- | --- |
| Conversation | `TurnCoordinator`, `LiveRun` (input arrives from the runtime's caller, such as `execution-runner.ts`) | Admit executable input, own one live turn, expose status and commands, and apply retained queue/pause rules. |
| Execution | `ApplicationRunLoop.#runTurn`, `#finishTurn`, `RunToolRound.execute` | Advance the model–tool cycle, await addressed decisions and apply selected recovery. |
| Request construction | `RunRequestBuilder.prepareBoundary`, `build`, `ReadyModelRequest` | Admit steering, apply compaction and budget checks, then construct each attempt with scoped preparation/admission, cost and abort handles. |
| Model exchange | `ModelExchangeRequest.askModel` | Resolve the model, build each attempt, dispatch/consume its stream, roll back provisional output and retry; never execute tools. |
| Runtime recording | `RunResponseRecorder.record`, `toolContext` | Record response identity, usage/cost, native reasoning and tool facts into request-local views before publication/execution. |
| Segment lifecycle | `RunSegments.open`, `settle`, `withinRepairDeadline` | Own cancellation, event-view generations and pause-aware segment settlement without advancing turns. |
| Session acceptance bridge | `ApplicationTurnSession`, `SessionTurnAdapter.#acceptEvent`, `#acceptSegment` | Route runtime facts into Record before observation; no caller-managed persistence flags or continuity publication sequence. |
| Accepted conversation | `ConversationRecord.acceptObservedItem`, `markDispatched`, `acceptSegment`, `recover` | Own provider history, tool evidence, persistence selection, private recovery baselines and reconstruction; synchronously notify provider context. |
| Presentation | `SessionTurnAdapter.#consume`, `SessionStreamProcessor.process`, `TurnProjectionState`, `SessionToolTracker` | Project events, deduplicate rendered commands/starts, accumulate usage and retain presentation caches. |
| Provider context | `ProviderContinuity.acceptSegment`, `prepareRequest`, `prepareNewTurn` | Incorporate accepted history facts, publish response/checkpoint identity, settle debt and encode request continuity. |
| Session lifecycle | `SessionLifecycle` | Complete undo/retry/rewind/reset/import operations, including retirement, dependent resets and appropriate logging. |
| Logging | `ConversationLogger.log`, `dispatchEventToLog` | Deliver observational log events. No callback replays logs into the live provider-history store. |

For the runtime session, `ApplicationRunLoop` supplies synchronous acceptance through
its event queue before publishing to stream consumers. Dispatch evidence has a
separate `acceptToolDispatch` callback immediately before physical dispatch. A
presentation consumer therefore does not decide whether a tool call/result is
accepted, and final rendering cannot repair missing live history as a prerequisite
for the next request.

## What Record hides

`ConversationRecord` privately creates a `ConversationStore`, a
`ToolExecutionLedger` and an `AssistantTurnJournal`. Keeping different schemas is
useful: provider input, execution evidence and persisted assistant items serve
different readers. Session callers no longer coordinate writes to those three
objects.

- `acceptObservedItem` retains the original provider item for native tool history,
  updates tool evidence, accepts provider-facing history and journals normalized
  items. Legacy journal deduplication does not decide whether a reused call ID
  represents another tool execution.
- `beginSegment` captures accepted history before the segment. `acceptSegment`
  uses that baseline with `selectAcceptedStreamHistory` so a terminal full-history
  view or delta can replace the streamed representation without doubling it.
- `recover` applies a policy-selected reconstruction: it combines the journal
  baseline, retained privately at attempt/decision boundaries, with live settled evidence; it distinguishes unstarted from dispatched
  calls with unknown outcomes, and handles the relevant input rollback.
- Rewind, retry, reset and import operations keep accepted history and evidence
  changes together. Session lifecycle still owns generation invalidation,
  approval/cache cleanup, access state and public turn status.

Record does not construct model requests, classify retry errors, choose a retry
budget, execute a tool or stop a child process. `SessionInputPlanner` and request
preparation consume its history views. Provider continuity remains a session-owned
protocol concern. Record calls `ProviderContinuity.acceptSegment` synchronously
with terminal/partial status, response identity, accepted history snapshot and
unsettled calls. Context finishes response publication, checkpoint promotion and
debt synchronization before the next request. Diagnostics cannot revoke acceptance
or create a replayable execution failure.

The runtime still has request-local `state.input`, `state.history` and
continuation state. Provider delta construction, native compaction and approval
suspension need those views. Their existence is not evidence of competing
acceptance authority, but changing their synchronization still requires care.
Nested/subagent histories have their own callers; this boundary does not claim a
repository-wide elimination of `ConversationStore`.

## Run-loop public interface and internal ownership

`application-run-loop.ts` retains the public `ApplicationRunLoop`, its option and
session/dependency type exports, `normalizeApplicationInput`, `toModelTools` and
`MaxTurnsExceededError`. Public type definitions live in `run-loop-contracts.ts`;
request input/tool projection lives in `run-input.ts`. Existing callers do not
need to know those internal paths.

- `runTurn(session)` drives runtime-session turns (from `SessionTurnAdapter`) through bounded session operations.
  `startStream(agent, input, options)` and `continueRunStream(handle, options)`
  expose nested/legacy event views of the same advancement loop. Continuation
  refresh preserves accounting and approvals while checking provider provenance.
- `openTurn`/`closeTurn`, `steer`/`retractSteer`/`editSteer` retain the mailbox's
  FIFO request-boundary admission semantics. `abort` cancels the logical turn;
  `abortSegment` cancels its current view without discarding eligible injections.
- `grantRunBudgetExtension` grants against the paused/live run's existing budget.
  `budgetDisposition` in `run-budget-policy.ts` is the near-pure evidence-to-action
  policy; `RunBudget` still owns thresholds, sensors and finite grants. The loop
  still owns waiting for an addressed budget/approval answer. There is no new
  guard, threshold, escalation default or recovery policy.

The boundary builder does not advance the turn: it can await the loop's budget
decision lane, then refresh the resumed view before continuing preparation.
`build` returns `ReadyModelRequest`, including the exact provider request, unique
cost identity, generation guard, request-only abort/cleanup and a scoped admission
wrapper. The exchange invokes that wrapper around physical dispatch and stream
consumption, keeping `ApplicationRequestPreparation.run` alive for the complete
request. Model resolution precedes per-attempt construction, including retries;
retry attempts do not repeat logical-boundary compaction or increment turn count.

Request-only history slicing lives in `model/history-projection.ts`: it clones
from the last native compaction or local summary replacement boundary. This
lossy projection does not consult durable session state.
`session/conversation/conversation-state-projector.ts` retains durable ledger
reconciliation and re-exports the existing projection API for session callers;
the engine imports the model helper directly rather than depending on session.

`RunResponseRecorder` is not a second session acceptance owner. It maintains the
runtime's local history/input views and publishes through `EventQueue`, whose
synchronous acceptance callback still reaches `ConversationRecord` before stream
observers. Native reasoning and cost normalization are isolated in
`run-native-reasoning.ts` and `run-cost-records.ts`. Cost events remain live-only,
not replayable history items. Tool settlement remains in `ToolCallExecution`;
`RunToolRound` owns the per-response approval/settlement workflow and the recorder
supplies its evidence callbacks. No request construction or provider retry moves
into the session adapter.

## Caller obligations removed

Approval contexts retain runtime decision handles and policy evidence, not display
argument maps or command-ID snapshots. Presentation retains its own detached,
generation-guarded caches across waits. `TurnProjectionState` no longer mirrors a
continuation handle, current tool-call list, journal snapshot or response-ID copy.
The runtime session's unconsumed continuation call-ID reconstruction has been deleted.

`SessionLifecycle` absorbs the former `SessionManager`: callers invoke one complete
history operation, rather than mutate Record and then remember cleanup and logging.
Invalid/stale rewind targets and empty undo targets return without cleanup/logging.
An accepted history operation performs its mutation and retirement/reset/logging
synchronously, without an await where an old callback could interleave. Retry keeps
the original provider input and existing discarded-history log shape. Physical job
cancellation remains governed by the existing runtime and registry policy.

## Contracts that remain load-bearing

**Tool settlement and dispatch.** A call observed from the model is not proof
that its body ran. Record marks dispatch separately and retains completed,
aborted and unknown outcomes. Physical process/child registries remain the
source of stop evidence. Parallel siblings can already be in flight when another
operation fails; neither iterator backpressure nor failed publication establishes
that those siblings stopped.

**Cancellation.** Generation and abort checks revoke further advancement. A late
result cannot revive the cancelled turn. Cleanup must retain known outcomes and
follow the existing foreground/background stop policy before conflicting work
starts. Interrupting an await does not prove that an external effect stopped.

**Persistence acknowledgement.** Journal delivery preserves the existing session
sink's log-and-continue behavior on failure. `RecordAcceptanceReceipt` distinguishes
memory acceptance from callback acknowledgement, failure or no requested write.
Memory acceptance precedes event publication; a failed sink cannot undo it.
Callback acknowledgement does not claim a durable write. `ConversationLogWriter`
retains event-specific fsync and failure behavior, and direct durable gates outside
the session logger remain separate. There is no atomic transaction spanning tool
effects and log writes, and no new universal fail-stop persistence rule.

**Approval and recovery policy.** Approval modules own authorization decisions;
retry modules own classification, limits and recovery plans. An approval answer
must match the exact runtime interruption and generation before it can consume
the single-use pending wait. A duplicate, stale or structurally cloned address
cannot resolve a different wait; cancellation/reset retires the old callback. A recovery plan invokes Record reconstruction
and returns to the same execution owner. The completed-effect case must not
redispatch work merely because provider continuity was rejected or a write lacked
acknowledgement.

**Request and presentation policy.** Tool/instruction snapshots, context limits,
provider opaque-history portability, compaction and completion interventions remain
explicit request/turn policies. The presentation processor retains its existing
output safety cancellation path, but it does not mutate accepted history, ledger
or journal. Rich rendering and command deduplication still require state.

## A worked turn

1. The conversation admits “Inspect the config and update the command” and starts
   the owned turn.
2. The runtime asks the model. Observed call items pass through session acceptance
   into Record before they reach presentation.
3. Tool execution accepts dispatch evidence, completes the read, then awaits an
   edit approval. A steer, “Keep the old flag supported,” remains eligible for the
   next request boundary.
4. The addressed approval resumes the existing pending tool operation. Its outcome
   enters Record before the rendered result. Segment acceptance reconciles the
   terminal provider view and updates continuity.
5. The loop prepares another request from accepted conversation context, including
   tool outcomes and eligible steering. With no further tool calls or completion
   intervention, the loop ends.

Stop during approval interrupts that wait; Stop after dispatch requires truthful
outcome and stop evidence. Eligible background jobs retain their concrete
execution identity and may deliver later notifications without reviving the
foreground turn. A steer does not retroactively authorize changed tool arguments.

## Rationale and verification limits

The [v2 actor experiment (historical)](https://github.com/qduc/term2/blob/1cca21b541b3d2e9a55ddd81e3514c17ff5e1503/experiments/conversation-actor/v2/DESIGN.md)
retains the ownership and cancellation model without making the fake actor the
Retaining a mirrored generic continuation would create a second execution owner;
retaining independently writable history, ledger and journal collaborators would
create competing acceptance owners. Merely wrapping either arrangement would not
remove those obligations.

This consolidation keeps submission receipts, provider transports, approval policy,
retry policy and physical job registries separate because they have different
contracts. It does not prove that the resulting system is easy for a human to
understand. A comprehension check must trace the central loop and predict the
next operation in concrete approval, recovery and cancellation examples.

Behavioral evidence must cover the workflows a change touches: ordinary tool
turns, partial stream failure, approval/ask-user/post-execute waits, steering,
invalid-chain recovery after a completed effect, cancellation with late outcomes,
parallel work, compaction, rollover and persistence failure. Follow the repository's
verification and provider-testing policies. Earlier evidence in
[WORK.md (historical)](https://github.com/qduc/term2/blob/3eb1659181eeda00bb32f971ef15096911380172/docs/research/single-turn-owner/WORK.md) and the v2 simulations should be
read with their own scope; they are not proof of this acceptance boundary or of
improved human comprehension.

Current boundary-refactor evidence is retained in
[session-boundaries/WORK.md (historical)](https://github.com/qduc/term2/blob/3eb1659181eeda00bb32f971ef15096911380172/docs/research/session-boundaries/WORK.md).
