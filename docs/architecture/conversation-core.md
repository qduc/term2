# Follow the model–tool loop

`ApplicationRunLoop.#runTurn` in
[`application-run-loop.ts`](../../source/services/agent-runtime/application-run-loop.ts)
owns execution advancement. In the root session path,
[`ConversationRecord`](../../source/services/conversation/conversation-record.ts)
owns acceptance of provider history, tool evidence and assistant journal items.
Presentation observes those facts; it does not commit them.

```mermaid
flowchart TD
    Input[User input] --> Loop
    subgraph Runtime[One execution owner: ApplicationRunLoop]
        Loop[Ask model] --> Calls{Tool calls?}
        Calls -->|yes| Tools[Execute and settle tools]
        Tools --> Loop
        Calls -->|no| Finish[Completion policy: finish or continue]
        Finish -->|continue| Loop
        Tools <-->|suspend / resolve| Decision[Addressed decision wait]
    end
    Answer[Approval answer] --> Decision
    Loop -->|accept facts before publication| Record[ConversationRecord]
    Tools -->|accept dispatch and outcome facts| Record
    Record -->|synchronous accepted segment| Context[ProviderContinuity: provider context]
    Context -->|prepared request context| Loop
    Loop -. publish accepted events .-> Display[Presentation: retained caches]
    Tools -. publish accepted events .-> Display
    Commands[Undo / retry / reset / import] --> Lifecycle[SessionLifecycle: complete state operations]
    Lifecycle -->|coherent history transition| Record
```

The control cycle is model → tools → model. Acceptance happens during that cycle,
before the runtime publishes the corresponding event to observers. It is not a
later step that a UI consumer must finish before execution may proceed.

The root session supplies bounded callbacks through `ApplicationTurnSession`.
`SessionTurnAdapter.#acceptEvent` routes observed items and streaming fragments to
Record. `acceptToolDispatch` records dispatch evidence before a tool body can run.
`#acceptSegment` delegates to Record, which reconciles the segment and synchronously
informs `ProviderContinuity` before returning. The adapter does not inspect
checkpoints, publish response IDs or synchronize tool debt. `#consume` and `SessionStreamProcessor.process`
build presentation state, command deduplication and usage views.
`ConversationLogger` writes log events without replaying them to repair live
history.

Record privately owns `ConversationStore`, `ToolExecutionLedger` and
`AssistantTurnJournal`. Its operations decide history selection, preserve native
tool evidence, reconstruct recovery history, and keep rewind/reset/import changes
together. `beginSegment` retains a baseline so streamed accepted items and a
terminal history view can be reconciled without appending the same segment twice.
These representations still exist; their mutation rights no longer escape to
session callers.

The runtime still maintains request-local input, history and continuation views
for provider serialization, compaction and approval suspension. Those transport
views are not a second public conversation record. Submission records also remain
separate: they own queued input identity, edit/retract rules and delivery receipts.

The important side contracts are:

| Concern | Owner and contract |
| --- | --- |
| Approval and ask-user | Tool execution awaits an addressed decision. A saved answer carries the exact runtime interruption and generation; stale answers leave the current wait untouched. Answering resumes the existing turn. |
| Retry and recovery | Retry modules classify failures and select policy. Record reconstructs accepted evidence; `#runTurn` owns the next attempt. Completed and uncertain effects remain distinguishable. |
| Stop and background work | Turn cancellation revokes advancement. Concrete shell/child registries retain physical execution authority and applicable stop proof; a cancelled await alone proves no process stopped. |
| Persistence | Record delivers journal writes under the existing best-effort session sink policy. A sink acknowledgement is not proof of fsync; direct durable writer gates retain their own contracts. |
| Provider continuity | Record passes an authoritative accepted-segment fact synchronously to ProviderContinuity, which owns response publication, checkpoint promotion, debt synchronization and request lineage encoding. |
| Context and completion policy | Request preparation owns compaction and request limits. `#finishTurn` makes an explicit continuation decision when existing completion policy requires another round. |

`SessionLifecycle` performs undo, retry, rewind, reset and import as complete
operations. A rejected history target performs no cleanup or undo logging.
Successful synchronous history changes retire the old turn, invalidate its
generation, reset dependent state and construct the appropriate log snapshot
before returning. The old `SessionManager` and public post-undo hooks are gone.
This boundary requests cancellation under the existing foreground/background
policy; returning from undo does not prove that every physical job has stopped.

Presentation keeps its argument caches across decision waits; approval contexts
carry neither argument maps nor command-deduplication snapshots. Record privately
keeps recovery baselines at attempt and decision boundaries. Recovery policy
selects a boundary without copying or interpreting journal representations.

An approval await leaves UI commands responsive. A steer received while waiting
becomes eligible at the next request boundary; it does not alter accepted tool
arguments retroactively. Known outcomes remain evidence after cancellation;
physical work that may still produce effects remains an execution-owner concern.

Open `#runTurn` first, then follow the relevant operation. The
[detailed design](conversation-loop.md) maps the boundaries and remaining
complexity. The [v2 experiment](../../experiments/conversation-actor/v2/DESIGN.md)
is historical ownership and cancellation evidence; its event-driven actor is not
the production execution structure. Earlier implementation evidence remains in
[WORK.md (historical)](https://github.com/qduc/term2/blob/3eb1659181eeda00bb32f971ef15096911380172/docs/research/single-turn-owner/WORK.md). Source structure and passing
workflows do not establish that human comprehension improved; that remains
unmeasured.
