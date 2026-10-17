# Execution and acceptance in a conversation turn

Start with the [central flow](conversation-core.md). The production execution
owner is `ApplicationRunLoop.#runTurn`; the root session's acceptance owner is
`ConversationRecord`. These are distinct responsibilities: the loop decides
when another model/tool step runs, while Record decides which observed facts
become accepted conversation history and recovery evidence.

## The central control path

`#runTurn` awaits request preparation, model exchange and tool settlement in
sequence. `#recordResponse` produces the requested tool plan. With no tool calls,
`#finishTurn` applies the existing completion policy and either finishes or makes
continuation explicit. Session recovery returns to this same loop.

```text
repeat:
    prepareRequest()
    response = await askModel()
    calls = recordResponse(response)
    await executeTools(response, calls)
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
| Conversation | `ConversationAdapter.submitMessage`, `TurnCoordinator`, `LiveRun` | Admit executable input, own one live turn, expose status and commands, and apply retained queue/pause rules. |
| Execution | `ApplicationRunLoop.#runTurn`, `#prepareRequest`, `#askModel`, `#executeTools`, `#finishTurn` | Advance the model–tool cycle, await addressed decisions and apply selected recovery. |
| Session acceptance bridge | `ApplicationTurnSession`, `SessionTurnAdapter.#acceptEvent`, `#acceptSegment` | Route runtime facts into Record before observation; publish provider continuity from the accepted segment receipt. |
| Accepted conversation | `ConversationRecord.acceptObservedItem`, `markDispatched`, `acceptSegment`, `recover` | Own provider history, tool evidence, journal delivery and reconstruction. |
| Presentation | `SessionTurnAdapter.#consume`, `SessionStreamProcessor.process`, `TurnProjectionState`, `SessionToolTracker` | Project events, deduplicate rendered commands/starts, accumulate usage and retain presentation caches. |
| Logging | `ConversationLogger.log`, `dispatchEventToLog` | Deliver observational log events. No callback replays logs into the live provider-history store. |

For the root session, `ApplicationRunLoop` supplies synchronous acceptance through
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
  snapshot with live settled evidence, distinguishes unstarted from dispatched
  calls with unknown outcomes, and handles the relevant input rollback.
- Rewind, retry, reset and import operations keep accepted history and evidence
  changes together. Session lifecycle still owns generation invalidation,
  approval/cache cleanup, access state and public turn status.

Record does not construct model requests, classify retry errors, choose a retry
budget, execute a tool or stop a child process. `SessionInputPlanner` and request
preparation consume its history views. Provider continuity remains a session-owned
protocol concern; its terminal publication follows Record's segment acceptance.

The root runtime still has request-local `state.input`, `state.history` and
continuation state. Provider delta construction, native compaction and approval
suspension need those views. Their existence is not evidence of competing
acceptance authority, but changing their synchronization still requires care.
Nested/subagent histories have their own callers; this boundary does not claim a
repository-wide elimination of `ConversationStore`.

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
Callback acknowledgement does not claim a durable write. `ConversationLogWriter`
retains event-specific fsync and failure behavior, and direct durable gates outside
the session logger remain separate. There is no atomic transaction spanning tool
effects and log writes, and no new universal fail-stop persistence rule.

**Approval and recovery policy.** Approval modules own authorization decisions;
retry modules own classification, limits and recovery plans. An approval answer
resolves the pending runtime wait. A recovery plan invokes Record reconstruction
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

The [v2 actor experiment](../../experiments/conversation-actor/v2/DESIGN.md)
made phase/token ownership explicit but required a reader to reconstruct the
model–tool cycle from handlers. The async-loop choice keeps that cycle visible.
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
[WORK.md](../research/single-turn-owner/WORK.md) and the v2 simulations should be
read with their own scope; they are not proof of this acceptance boundary or of
improved human comprehension.
