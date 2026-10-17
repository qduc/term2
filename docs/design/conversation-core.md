# Follow the model–tool loop

The production entry point is `ApplicationRunLoop.#runTurn` in
[`application-run-loop.ts`](../../source/services/agent-runtime/application-run-loop.ts).
A turn starts with accepted input and runs this loop:

```mermaid
flowchart TD
    Input[Accept input] --> Prepare[Prepare the next request]
    Prepare --> Model[Ask the model]
    Model --> Record[Record the response]
    Record --> Calls{Tool calls?}
    Calls -->|yes| Tools[Execute tools and record outputs]
    Tools --> Prepare
    Calls -->|no| Finish[Finish the turn]
```

The central function follows that diagram. In illustrative pseudocode, including
the explicit completion-policy extension:

```text
async runTurn(turn):
    repeat:
        request = await prepareRequest(turn)
        response = await askModel(turn, request)
        recordResponse(turn, response)

        if response has tool calls:
            await executeTools(turn, response.toolCalls)
        else:
            if await finishTurn(turn, response) == done:
                return
```

Ordinarily, no tool calls means the turn ends. Tool execution may wait for a required
post-execution decision. If existing completion policy requests another model
round, `finishTurn` returns `continue` to this loop; it cannot secretly start another loop.
The same runtime loop owns session recovery: a policy callback permits recovery or throws, and the loop prepares the next attempt. Stop exits through its cleanup boundary.

`SessionTurnAdapter` prepares session input, projects events and supplies decisions. An approval answer resolves a promise awaited by the runtime; it does not launch another stream. `TurnCoordinator` owns admission, public status and hooks. `TurnWorkflow` has been removed.

Session projection follows the same lifetime. `SessionTurnAdapter` creates one
`TurnProjectionState` before the first stream and processes every segment through
`#projectStream`: consume events, finalize history, report compaction, and build
the result. Approval binds a decision to that existing state; it does not copy
accumulated projection facts into a continuation state. Command deduplication and
latest cumulative usage remain in the state, while the existing turn accumulator
and conversation store retain accepted items and history. A recovery resets
attempt-specific projection facts on that same object before replaying; retry
input and policy remain separate in `TurnAttempt` and the recovery handlers.

Each feature has a place around this flow:

| Feature | Where the reader goes | What it does |
| --- | --- | --- |
| Follow-ups, editing, retracting | `ConversationAdapter.submitMessage` and its submission records, outside `runTurn` | Keep accepted input editable until consumed; start the next eligible turn after this one settles. |
| Steering | `prepareRequest` | Consume eligible steer input at the next request boundary; unconsumed steers return to queue policy when the turn ends. |
| Prompts, modes, skills and tool availability | Conversation submission preparation and `askModel` request snapshot | Assemble instructions and the request's tool snapshot; execution still checks tool authority. |
| Context limits and compaction | `prepareRequest` | Build a valid request from accepted history, applying context policy before dispatch. |
| Streaming and provider protocols | `askModel` | Publish incremental output, retain committed facts, and translate the provider's response into the loop's common form. |
| Retry and recovery | Safe request retry inside `askModel`; session recovery in `runTurn` | Existing policies authorize retry using the same turn budget; the runtime owns repetition, and uncertain effects are not blindly replayed. |
| Approval and ask-user | `executeTools` | Wait at the relevant tool, then continue the same tool plan. |
| Parallel tools | `executeTools` | Dispatch eligible independent calls together; settle their results in the required order before the next model request. |
| Background tools and child tasks | `executeTools`, backed by owned executions | Return a job handle when backgrounding is accepted; retain the running job and deliver eligible results as later input. |
| Budgets | Request and tool boundaries | Apply the existing policy before more work; a grant continues the same turn with the same accounting. |
| Stop | Turn owner, around the loop | Revoke advancement, interrupt waits, request execution stop, and settle history. Replacement admission waits for the applicable stop proof. |
| Rollover and restart | Conversation lifecycle, outside the loop | Change context and eligible work ownership. Restart does not automatically resume the interrupted loop. |
| UI and persistence | Observe events; journal accepted facts | Show progress and retain history without independently deciding which step runs next. |

An `await` for approval leaves the UI and command handling responsive. It does not
hold the JavaScript event loop. A tool result describes what is known; stop proof
describes whether its execution can still make effects. That distinction stays
inside execution ownership and cleanup rather than becoming another top-level
flowchart. Known pre-cancellation outcomes remain facts; later results cannot revive
the revoked turn.

A human should first open `runTurn`, then follow **one operation** to answer a
specific question: “Why are we waiting for approval?” → `executeTools`; “Why this
model input?” → `prepareRequest`; “Why won't the next turn start?” → conversation
admission and execution cleanup.

The [detailed design](conversation-loop.md) defines these operations, shows a worked
turn, maps current owners, and specifies what must disappear during migration.
The [v2 experiment](../../experiments/conversation-actor/v2/DESIGN.md) remains
historical evidence about ownership and cancellation rules. Its event-driven actor
is not the production central implementation. The
[implementation evidence](../research/single-turn-owner/WORK.md) records
verification and its limits. Source readability can be inspected directly; a
human comprehension improvement has not been measured.
