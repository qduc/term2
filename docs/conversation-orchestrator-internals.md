# ConversationOrchestrator internals

`source/services/conversation/conversation-orchestrator.ts` (~910 lines).
Verified against source on 2026-08-02.

The UI-side half of a turn. `use-conversation.ts` owns one instance. It converts
`ConversationEvent`s into Ink message-list state and owns every path that *starts* a
turn from the UI. Unlike `TurnWorkflow`, its complexity is not control flow — it is
**state that must stay consistent across four entry points and one background path**.

## The four turn entry points

Every one has the same five-phase shape. Learn it once and the file reads quickly:

```
#beginTurn(label)              → ++activeTurns, ui.onTurnStart(), createTurnSession()
  try
    await conversationService.<call>({ onEvent: createOnEventHandler(apply) })
    applyConversationEvent({type:'final'}) ; botResponseUpdater.flush()
    applyServiceResult(result, streamingState, latestUsage)
  catch  → logError → isAbortLikeError? swallow : appendBotError + onApprovalResolved
  finally → reasoningUpdater.flush() ; botResponseUpdater.cancel() ; #endTurn()
```

| Entry point | Line | Notes |
| --- | --- | --- |
| `sendUserMessage` | 378 | the complicated one — see queue ownership below |
| `handleApprovalDecision` | 502 | also hosts the `ask_user` question machine and the max-turns branch |
| `retryLastToolOutput` | 329 | trims trailing assistant messages first, bails if nothing to retry |
| `#deliverBackgroundSubagentNotifications` | 651 | system-initiated; no user message |

**If you add a fifth entry point, it must follow this shape exactly** — in particular
`botResponseUpdater.cancel()` in `finally` and a matching `#endTurn()`. An unmatched
`#beginTurn` permanently wedges background-notification delivery (see below).

## The hard part: turn ownership vs. queue ownership

`#activeTurns` (138) counts only executions that have **actually started**. A message
submitted while another turn is in flight is owned by the queue, not the orchestrator —
it may never run at all (user removes or discards it), so counting it at submit time
would require a matching `#endTurn` for work that never happened.

The resolution is `#deferredTurnActivators` (132):

```
sendUserMessage
  queueOwnsSubmission? ──yes──> createTurnSession()   (bind streaming, DON'T count)
  │                             register activator under userMessage.id
  │                             ui.onQueuedMessagePending(...)   ← indicator above input box
  └──no───────────────────────> #beginTurn()          (count immediately)
                                messages.appendMessages([userMessage])
                                #directlyAppendedMessageIds.add(id)

later, queue pops the head → setQueuedTurnStartObserver (154)
  → activator fires: ++activeTurns, ui.onTurnStart()
  → moveQueuedMessageIntoList(requestId, input)
```

Three guards exist purely to keep this consistent, and all three are load-bearing:

- **`#directlyAppendedMessageIds`** (125) — the direct-append path and the queue
  observer can *both* fire for the same message. `moveQueuedMessageIntoList` (830)
  checks this set and swallows the duplicate append, returning `wasAlreadyStarted`.
- **`turnActivated`** local (419) — the `finally` calls `#endTurn()` only if the turn
  was ever activated. The catch block also returns early (458) so a submission that
  never left the queue does not paint a bot error into the transcript.
- **`wasAlreadyStarted && !activateDeferred`** (166) — recovered or test-only queue
  starts that have no activator still need `ui.onTurnStart()`.

`moveQueuedMessageIntoList` **rebuilds** a minimal `UserMessage` from the id and input
rather than looking up the original (comment at 840): by the time the queue fires, the
original object may no longer be reachable.

## Background subagent notifications

The subtlest logic in the file (`#deliverBackgroundSubagentNotifications`, 651). A
background run can settle while the conversation is idle, with nothing to wake the agent.

**Delivery requires full idleness** — four gates at 653–656: pending count, not
stopping, `#activeTurns === 0 && !pendingApproval`, queue not active. Otherwise the
store retains the notifications and the *next* `#endTurn` retries.

The anti-spin mechanism is the `delivered` flag plus `#endTurn(flushNotifications)`:

```
result truthy?  → delivered = true  → #endTurn(true)   → may chain another delivery
result falsy?   → pending.retain(notifications)        (queue refused; never seen)
                → #endTurn(false)  → does NOT re-trigger delivery
```

A falsy `result` means the queue declined to admit the turn, so the notifications were
never seen by the model and must go back. Re-attempting immediately would spin, which is
why only a *delivered* batch is allowed to chain.

`stopProcessing` (227) sets `#stoppingByUser` around the teardown. Cancelling background
runs makes each emit its own completion event; without the flag those would queue up and
wake the agent to announce runs the user just asked to stop. The flag suppresses, then
`drain()` (251) discards.

Two message formatters at the top of the file are **product behavior, not
documentation**: `formatBackgroundSubagentNotifications` (39) is the model-facing
instruction; `formatBackgroundSubagentNotificationDisplay` (100) is the user-facing
companion. Edits there change agent behavior — treat them like prompt changes.

## Event handling

`createOnEventHandler` (741) wraps the streaming session's handler to drive **UI
indicators** that are not part of message state:

- `reasoning_delta` → thinking indicator on; `text_delta` / `tool_started` /
  `tool_call_streaming_delta` / `final` → off (`clearsThinkingIndicator`, 881).
- `tool_call_streaming_delta` → live tool-name + arg-char counter.
- `user_message_consumed_for_abort` → marks the last user message and **returns early**,
  never reaching `baseOnEvent`. The only event the orchestrator fully intercepts.
- `subagent_completed` → accumulates subagent usage separately from main usage.

`applyServiceResult` (779) is the **single place a terminal is applied**. Two branches:
`approval_required` stores `pendingApproval`, filters pending command messages, and
notifies; everything else clears it and runs `computeNextMessages`. All four entry
points funnel here — put new terminal handling in this method, not in a caller.

## Reset paths

Four methods reset overlapping state, and the overlap is easy to get wrong:

| Method | messages | approvedContext | pendingApproval | askUser | ids | usage |
| --- | --- | --- | --- | --- | --- | --- |
| `clearConversation` (209) | `[]` | ✓ | ✓ | ✓ | ✓ | ✓ reset |
| `stopProcessing` (227) | running→aborted | ✓ | ✓ | ✓ | ✓ | — |
| `rewindToTurn` (266) | `slice(0, uiIndex)` | ✓ | ✓ | ✓ | ✓ | — |
| `retryLastToolOutput` (329) | trim trailing | ✓ | ✓ | ✓ | — | — |

`rewindToTurn` is the **single rewind path** — `/rewind`, `/undo`, and `/retry` all land
there (comment at 262), which is what keeps their reset semantics identical. Don't add a
parallel one.

Note `retryLastToolOutput` does *not* clear `#directlyAppendedMessageIds` or
`#displayedBackgroundNotificationMessageIds` while the other three do. That looks
deliberate (it keeps the existing transcript) but is undocumented in the source.

## The `ask_user` question machine

Embedded in `handleApprovalDecision` (511–546). Multi-question flows re-enter this
method once per question, accumulating into `askUserAnswers` and returning early
(540) until `nextAnswers.length === questions.length`, at which point the whole array is
JSON-stringified as the approval answer. `goToPreviousQuestion` (194) pops.
`is_multi_select` questions parse their answer as a JSON array, falling back to a plain
string.

Both `JSON.parse` calls are silently caught. A malformed `argumentsText` yields
`questions = []`, which makes the flow complete immediately with one answer.

## Known rough edges

- **`questions: any[]`** (512) — the ask_user payload is parsed untyped.
- **Optional-method probing.** `typeof service.setQueueStateObserver === 'function'`
  and friends appear at 145, 154, 175, 310, 398. The orchestrator treats
  `ConversationService` as partially optional, which weakens the contract on both sides;
  the fallback chain at 397–400 (`isQueueOwningSubmissions ?? isQueueActive ?? false`)
  is where a wrong default silently changes queue behavior.
- **Error-handling duplication.** The catch blocks at 358, 444, 606, and 702 are the
  same classify-log-append sequence four times, with small divergences (only
  `sendUserMessage` handles `droppedUserMessage` and max-turns) that are hard to tell
  intentional from accidental.
