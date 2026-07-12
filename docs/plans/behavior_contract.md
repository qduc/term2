# Term2 Queue and Turn Behavior Contract

This is the behavioral contract for foreground-message queuing. It specifies observable behavior and durable state, not a required class layout.

## Ownership and public boundary

The **Queue Controller** owns the queue state machine, queue-item admission, dispatch, persistence, and transcript/control-event projection. It is the sole writer of the queue state and is the public boundary for the UI, slash-command layer, and turn lifecycle:

```ts
type QueueCommand =
  | { kind: 'submit'; text: string }
  | { kind: 'cancel' }
  | { kind: 'answer_preflight'; itemId: ItemId; actionId: ActionId; accepted: boolean }
  | { kind: 'resolve_tool_approval'; executionId: ExecutionId; actionId: ActionId; approved: boolean }
  | { kind: 'answer_ask_user'; executionId: ExecutionId; actionId: ActionId; value: string }
  | { kind: 'resume_queue' }
  | { kind: 'discard_queue' }
  | { kind: 'edit_queued'; itemId: ItemId; text: string }
  | { kind: 'remove_queued'; itemId: ItemId }
  | { kind: 'change_execution_settings'; settings: ExecutionSettings }
  | { kind: 'change_cosmetic_settings'; settings: CosmeticSettings };

type TurnEvent =
  | { kind: 'tool_approval_requested'; executionId: ExecutionId; actionId: ActionId; request: ToolRequest }
  | { kind: 'ask_user_requested'; executionId: ExecutionId; actionId: ActionId; question: AskUserQuestion }
  | { kind: 'completed'; executionId: ExecutionId; terminal: ConversationTerminal }
  | { kind: 'failed'; executionId: ExecutionId; failure: FailureSummary }
  | { kind: 'cancelled'; executionId: ExecutionId };
```

The concrete payload types are owned by their existing contracts; the discriminants and IDs above are normative. The controller MUST return a defined result (`accepted`, `rejected` with a reason, or `no_op`) for every `QueueCommand` in every state. It MUST NOT throw merely because a command is inapplicable.

`TurnStatusMachine` is deliberately separate and remains the low-level, single-turn transition validator (`idle`, `streaming`, `awaiting_approval`, `continuing`). The Queue Controller starts, continues, or aborts a turn through the turn/session boundary and consumes its `TurnEvent`s. It MUST NOT treat a `TurnStatusMachine` status as its own queue state, nor use it to infer queue ownership.

## Glossary and data model

| Term | Meaning |
| --- | --- |
| **Item** | One accepted normal user message awaiting execution or preflight confirmation. It is not a turn until dispatched. |
| **Execution** | One attempt to run an item, identified by a fresh `ExecutionId`. Retries of the same item create a new execution ID. |
| **Active execution** | The sole execution owned by the controller while in `running`, `awaiting_active_action`, `cancelling`, or `completing`. |
| **Preflight guard** | A cost/input warning evaluated before a turn starts (for example input-surge or large-uncached-input warning). It is not a tool approval. |
| **Active action** | An interaction emitted by an executing turn: `tool_approval` or `ask_user`. |
| **Admission barrier** | The synchronous controller transition that claims or retires an execution ID before work may start or a terminal result may dispatch another item. |
| **Paused** | A stable state in which queued work is retained but dispatch is disabled. `pauseReason` records why. |

An item has the following logical model. Storage may add harmless metadata, but MUST preserve these fields and meanings:

```ts
type QueueItem = {
  id: ItemId;                 // stable, unique within the session
  text: string;               // immutable after dispatch
  sequence: number;           // monotonically increasing FIFO order
  submittedAt: string;        // informational ISO-8601 timestamp
  preflight?: { actionId: ActionId; kind: 'input_surge' | 'large_uncached_input' };
};
```

An item is `queued` until the dispatch barrier claims it; it is then removed from the queue and represented by `active`. A queued item MAY be edited or removed by ID. An active or completed item MUST reject those operations. The configured capacity counts queued items, not the active item; a rejected submission MUST leave the input buffer and existing queue unchanged.

## Queue states and invariants

| State | Active execution | Dispatch permitted | Meaning |
| --- | --- | --- | --- |
| `idle` | none | yes | No active work and no paused condition. |
| `awaiting_preflight` | none | no | Head item has a pending preflight guard. |
| `running` | one | no | The active turn is streaming or continuing. |
| `awaiting_active_action` | one | no | The active turn awaits a typed tool approval or `ask_user` answer. |
| `cancelling` | one | no | Abort and owned-resource cleanup are in progress. |
| `completing` | one | no | A matched terminal event has been admitted; its final projection is being committed. |
| `paused` | none | no | Queue retention is intentional; `pauseReason` is `failure`, `manual`, or `recovered_interrupted`. |

There is no `failed` state: failure is a terminal event that yields `paused { pauseReason: 'failure' }`. Thus `failed` and `queue_paused` cannot overlap.

The controller MUST maintain these invariants:

1. At most one active execution exists, and its ID is unique for the lifetime of the session.
2. Only the queue head may be considered for preflight or dispatch; accepted items execute in increasing `sequence` order.
3. An event or action whose `executionId`, `itemId`, or `actionId` does not match the current owner is stale and has no state, transcript, or dispatch effect.
4. No dispatch occurs while `cancelling`, `completing`, an action is pending, or the queue is paused.
5. An item is either queued, active, or terminal—never more than one of these.

## Transitions, barriers, and actions

The controller serializes commands and events. The following are the only state-changing transitions; all other inputs have the total-command outcome defined below.

| From | Accepted input | Required transition/effect | To |
| --- | --- | --- | --- |
| `idle` | submit or post-terminal dispatch | Enqueue if needed; evaluate head preflight | `awaiting_preflight`, `running`, or `idle` |
| `awaiting_preflight` | matching accepted preflight | Capture snapshot and claim head at the dispatch barrier; start turn | `running` |
| `awaiting_preflight` | matching declined preflight | Remove head without starting a turn; consider next head | `idle`, `awaiting_preflight`, or `running` |
| `running` | matching tool/ask-user request | Record the typed active action and suspend/await continuation | `awaiting_active_action` |
| `awaiting_active_action` | matching action resolution of the same kind | Continue the active turn with that resolution | `running` |
| `running` or `awaiting_active_action` | matching completed | Enter completion barrier, commit terminal projection, retire active ownership, then consider head | `completing`, then `idle`/`awaiting_preflight`/`running` |
| `running` or `awaiting_active_action` | matching failed | Retire active ownership and retain queue | `paused` (`failure`) |
| active state | cancel | Enter cancellation barrier, request abort once, clean up recursively | `cancelling` |
| `cancelling` | matching cancelled or cleanup finished | Retire active ownership; retain queue | `paused` (`manual`) |
| `paused` | resume_queue | Clear pause reason and consider head | `idle`/`awaiting_preflight`/`running` |

### Preflight versus active actions

Preflight guards are evaluated at execution time, before the dispatch barrier and before `TurnStatusMachine.beginTurn()`. Their action IDs are item-scoped and only accept `answer_preflight`. A `tool_approval_requested` and an `ask_user_requested` are execution-scoped active actions; only `resolve_tool_approval` and `answer_ask_user`, respectively, may resolve them. Implementations MUST NOT represent these three interactions as one untyped “approval,” and MUST NOT send a preflight answer to a tool or subagent.

### Admission barriers

At the **dispatch barrier**, the controller MUST, as one serialized transition: verify that it is dispatchable and the item is the head; capture the execution snapshot; allocate `executionId`; remove the item from the queue; install `active`; and only then request turn start. A failure before turn start returns the item to the head or pauses with a recorded failure; it MUST NOT silently lose it.

At the **completion barrier**, the controller MUST first verify the matching active `executionId` and move to `completing`. Until the terminal projection is committed and ownership retired, submissions only enqueue and no dispatcher may start work. Exactly one matched terminal event can retire an execution. Late duplicate terminal, output, child, or tool events are stale and MUST be ignored after retirement or cancellation begins.

Cancellation similarly installs the `cancelling` barrier before signalling abort. It MUST signal the active execution at most once, cancel owned subagents during cleanup, and wait for cleanup completion before any future dispatch. A cancel with no active execution is a `no_op`, not an error.

## Total command behavior

| Command | Behavior in every state |
| --- | --- |
| `submit` | Validate and append FIFO item, or reject on capacity/validation. In `idle` it MAY immediately drive the dispatcher; in every other state it remains queued. Natural-language “stop” is a normal submission, never cancellation. |
| `cancel` | In an active state, start cancellation as above; in `cancelling`, return `no_op`; otherwise return `no_op`. |
| `answer_preflight` | Accept only in `awaiting_preflight` for the matching head item/action; otherwise reject as stale or inapplicable. |
| `resolve_tool_approval` / `answer_ask_user` | Accept only in `awaiting_active_action` for the matching execution/action and action kind; otherwise reject as stale or inapplicable. |
| `resume_queue` | Only `paused` resumes. In all other states it is `no_op`. |
| `discard_queue` | Remove all queued items in every state. It never aborts or mutates active work; an active execution may still complete into an empty queue. |
| `edit_queued` / `remove_queued` | Act only on an identified queued item. Missing, active, or terminal IDs are rejected without mutation. Removing the pending preflight head re-runs head selection. |
| execution-setting change | Persist the new default in every state; it affects only a later dispatch. |
| cosmetic-setting change | Apply/persist it immediately in every state; it has no execution effect. |

## Execution snapshots and retry lifetime

An execution snapshot is captured exactly once at the dispatch barrier and remains immutable through streaming, active actions, continuation, cancellation, and terminal projection. It MUST contain the item ID and text, model/provider selection, temperature and other generation parameters, system instructions, tool-policy/approval policy, and the session/conversation context reference or immutable version used to construct the turn. It SHOULD contain any other execution-affecting setting needed for reproducibility; cosmetic settings MUST NOT be included as execution inputs.

Changing execution settings never changes an active snapshot. A queued item has no final execution snapshot, so it uses the defaults current when it reaches its dispatch barrier. A retry is a new execution with a new `ExecutionId` and a newly captured snapshot; it MUST NOT mutate the historical snapshot or reuse a prior active action ID.

## Persistence and recovery

The persisted queue record is a versioned, atomically replaced JSON document:

```ts
type PersistedQueueV1 = {
  version: 1;
  nextSequence: number;
  queue: QueueItem[]; // sorted by sequence, including a pending preflight head
  pause?: { reason: 'failure' | 'manual' | 'recovered_interrupted'; detail?: FailureSummary };
  active?: {
    executionId: ExecutionId;
    item: QueueItem;
    snapshot: ExecutionSnapshot;
    phase: 'running' | 'awaiting_active_action' | 'cancelling' | 'completing';
    pendingAction?: { actionId: ActionId; kind: 'tool_approval' | 'ask_user' };
  };
};
```

The controller MUST persist after every queue, pause, preflight, active-ownership, and terminal-ownership mutation, using an atomic-replace or equivalent all-or-nothing protocol. It MUST validate `version`, required IDs, and strictly increasing queue sequence on load; an invalid record MUST be quarantined/ignored with a visible recovery error rather than partially executed.

On restart, no provider call, tool, subagent, approval, or active turn is resumed automatically. If `active` was persisted, it represents interrupted work: its item MUST NOT be re-enqueued automatically and its snapshot is retained only as recovery/audit information. The remaining queue is recovered in `paused { reason: 'recovered_interrupted' }` and requires `resume_queue`; a saved preflight remains pending and MUST receive a freshly issued preflight action ID before it can be confirmed. If no active work was persisted, a saved manual/failure pause is retained; otherwise recovered queued work is still paused before any paid work starts.

## Transcript and control events

An accepted `submit` creates one user transcript message for that item, in submission order. It MUST NOT be injected into an active turn and later run again. A matched terminal completion creates its normal terminal transcript entry exactly once. Tool requests, `ask_user` prompts and answers, preflight warnings/answers, queue status, failures, cancellation notices, retries, settings changes, and slash commands are control events: they MAY be rendered in the UI or audit log, but MUST NOT become ordinary user conversational messages or model-history turns. In particular, `/cancel` is not transcript content and no CLI log is transcript content. Only the active execution’s accepted output may be projected into the conversation transcript.

## Acceptance criteria

Tests MUST use controllable barriers and explicit IDs; they MUST NOT rely on wall-clock “simultaneous” actions.

1. **Completion/submission race:** hold execution `E1` at its completion barrier; submit item `I2`; release the barrier. Assert `I2` has one queue/dispatch lifecycle, `E1` produces one terminal entry, and exactly one execution for `I2` starts.
2. **Cancellation late event:** hold cleanup for `E1` after `cancel`; inject `completed`, tool output, and child completion events tagged `E1`; release cleanup. Assert none is projected, no item dispatches before release, and the resulting state is `paused` with retained queue.
3. **Typed interaction isolation:** hold `I1` at preflight action `P1`; deliver a tool approval resolution and an answer for a different preflight ID, then decline `P1`. Assert neither mismatched action starts a turn and no tool continuation occurs. Separately, hold `E1` at `ask_user` action `A1`; assert tool-approval resolution for `A1` is rejected.
4. **Snapshot/retry:** start `E1` after capturing Model A; change defaults to Model B while it is held at an active action; continue `E1` and assert it uses A. Fail it, resume its queued successor, and assert the successor captures B. If `I1` is retried, assert its new execution ID and snapshot are distinct from `E1`.
5. **Recovery:** persist a record containing active `E1`, queued `I2`, and a pending action; construct a new controller from it. Assert no turn starts until `resume_queue`, `I1` is not auto-replayed, state is `paused(recovered_interrupted)`, and stale `E1`/old-action events have no effect.
6. **Failure isolation:** inject matched failure for `E1` with `I2` and `I3` queued. Assert state is only `paused(failure)`, neither item starts before explicit resume, and FIFO dispatch after resume begins with `I2`.
