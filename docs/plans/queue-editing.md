# Editing and deleting a submitted-while-busy prompt

## Resume here

**Steps 1–4 (`## Build order`) are done and merged to `main`**: Steps 1–2 are
`ccc02324` / `b5f31095`, the re-derived Step 3 is merge commit `f1eebcc5`
(implementation `19a3f22d`), and Step 4's inline ID-addressed editor is
`061427c8` (all steps are included by `a7a0d677`). Read `## The three stages`
before touching `ConversationOrchestrator`, `ConversationService`,
`ConversationAdapter`, `QueueController`, `PendingQueueList`, or the
`pendingQueuedMessages` reducer slice: the run loop owns pending steers, the
queue controller owns queued state, the adapter routes the shared submission
ID and executable payload, and Ink owns only projection and editing UI.

Interaction surface was chosen by the user: **inline selectable list above the
input box**, entered by ↑ on an empty input. Not a modal. See `## Rejected`.

### What shipped in Steps 1–2

- `ApplicationRunLoop` (`application-run-loop.ts`): exports `SteerOutcome =
  'admitted' | 'released' | 'retracted'`; `steer` takes `options?: { id?:
  string }` and returns `Promise<SteerOutcome>`; `PendingSteer` carries an
  optional `id`; `retractSteer(id)` and `editSteer(id, items)` are new,
  synchronous, and documented as racing `#admitPendingSteers` only in theory —
  both are synchronous single-pass operations against `#pendingSteers`, so one
  always completes before the other can observe a stale array.
- **The four-caller list in `## Design` §1 was incomplete for §2 to work.**
  `retractSteer`/`editSteer` also had to be threaded through `AgentClient`,
  `ConversationAgentClient`, `TurnWorkflow`, `TurnCoordinator`,
  `SessionRuntime['turns']` (`session-composition.ts`), and `TurnFlow`
  (`conversation-adapter.ts`) — not just `steer`. Without that, the adapter's
  `#pendingSteerIds` routing target (`this.#turnFlow.retractSteer?.(id)`)
  would always be `undefined` in production. This is now wired end-to-end:
  `session-composition.ts`'s `turns` object binds
  `turnCoordinator.retractSteer`/`editSteer` alongside the existing `steer`
  binding.
- `ConversationAdapter` (`conversation-adapter.ts`): added `SubmissionStage`
  and `SubmissionMutation` exactly as specced in `## Design` §2;
  `retractSubmission(id)` and `editSubmission(id, turn)`, routed by a new
  `#pendingSteerIds: Set<string>` populated by `injectIntoActiveTurn` around
  its `turnFlow.steer` call and cleared in a `finally`. `steerActiveTurn` and
  `injectIntoActiveTurn` both gained an optional `{ id }` parameter but kept
  their boolean return type — the `SteerOutcome` union is collapsed to
  `'admitted' → true`, everything else `→ false`, exactly as the plan
  specified for the shared background-notification caller.
- **The trap fix is in and has a regression test that asserts on delivery, not
  state.** `editSubmission` on a queued item writes the new `UserTurn` into
  `#messagesById` (what `#runQueuedTurn` actually executes) before issuing
  `edit_queued` with the display text (`QUEUED_NON_TEXT_PLACEHOLDER`
  substitution preserved). The adapter test
  `'editSubmission on a queued item sends the edited text — the #messagesById
  write edit_queued alone misses'` drives the queued turn to completion and
  asserts on what `turnFlow.start` actually received.
- `removeLastQueuedItem` is untouched, per scope — still the only mutation
  `InputBox` calls today.

### Step 3 decisions recorded

- **The pending-steer address is now wired through the real caller.**
  `ConversationOrchestrator.sendUserMessage` passes `userMessage.id` to
  `steerActiveTurn`, so `#pendingSteerIds` can route production edits and
  retractions to the run loop. A pending-steer edit also records the latest
  `UserTurn` so the eventual transcript and log match the provider input.
  - Same expected-signature note: `retractSteer`/`editSteer` were added to
  `TurnFlow` as truly optional (`?`), so a `turnFlow` that only implements
  `steer` still type-checks — Step 3's orchestrator wiring does not need a
  companion change here to compile, only to actually retract/edit anything.
- **A retracted pending steer resolves `steerActiveTurn` to `false` — the same
  value as "the turn had no boundary left."** Step 3 routes mutations directly
  through `retractSubmission`/`editSubmission` and marks a successful pending
  retraction before the original steer path considers its boolean result, so a
  deliberate retraction cannot fall through to a fresh submission.
- No change was needed to `QueueController` beyond what already existed:
  `edit_queued` and `remove_queued` were already implemented; Steps 1–2 gave
  them their first real callers (via `editSubmission`/`retractSubmission`) and
  added persistence round-trip coverage for `edit_queued`.
- **`editSubmission` is all-or-nothing at the queue boundary.** It writes the
  new `UserTurn`, then awaits `edit_queued`; when the controller rejects, Step 3
  restores the prior `#messagesById` entry before returning `too_late`. The
  regression test asserts on the turn eventually delivered to `turnFlow.start`,
  not only on queue display state.
- **Missing pending-steer mutation wiring fails explicitly.** If a pending id
  reaches the adapter without `retractSteer` or `editSteer`, the adapter throws
  a wiring error instead of misreporting the submission as already started.

### Testing run for Steps 1–2

`pnpm test:provider-black-box` (18 files / 152 tests) and `pnpm test` (419
files / 5230 passed, 1 pre-existing unrelated flaky `InputBox` timing test that
passes in isolation) both pass, along with `pnpm run typecheck` and `pnpm run
lint` (0 errors; pre-existing `require-yield` warnings only, none in touched
files). See the handoff report for the exact commands.

---

## What exists today

A prompt submitted while a turn is in flight takes one of two `busyMode` paths
(`InputBox.tsx:824`): Enter → `steer`, Alt+Enter → `follow_up`. Either way
`ConversationOrchestrator.sendUserMessage` (`conversation-orchestrator.ts:403`)
sees `queueOwnsSubmission === true`, draws a pending line, and tries delivery.

The only mutation available afterwards is up-arrow on an empty input
(`InputBox.tsx:784`), which calls `removeLastQueuedItem` — it pops the
**controller queue's tail** back into the input box and drops it. There is no
edit, no way to reach any item but the tail, and no way to touch a steer that is
still waiting for a request boundary.

## The three stages

A submission passes through three stages. Naming them is the point of this
design; the current code has no word for the first one, which is why it is
unreachable.

| Stage | Lives in | Duration | Reversible? |
| --- | --- | --- | --- |
| **Pending steer** | `ApplicationRunLoop.#pendingSteers` (`application-run-loop.ts:230`) | Until the turn's next request boundary — a long tool call or an approval can hold it for minutes | Yes, in principle. No API exists. |
| **Queued** | `QueueController.#queue` + `ConversationAdapter.#messagesById` | Until the active turn ends | Partially — `remove_queued` is wired for the tail only; `edit_queued` exists and **nothing calls it** |
| **Admitted / running** | Model history, or the active execution | — | No. The model has read it. |

Two facts about the boundary between them:

- A **pending steer is not in the controller queue.** `sendUserMessage` calls
  `steerActiveTurn` *before* falling through to `sendMessage`
  (`conversation-orchestrator.ts:418-451`). While the steer waits, the queue is
  empty.
- Both stages already share one identifier. `userMessage.id` is passed as
  `preferredMessageId` into `sendMessage` (`conversation-orchestrator.ts:484`),
  which the adapter uses verbatim as the controller item id
  (`conversation-adapter.ts:343`). The same id is what the UI reducer keys
  `pendingQueuedMessages` on. **One id already spans both stages** — it is just
  never handed to the run loop.

That last fact is the whole substrate. Everything below is: give the run loop
that id, and route mutations by stage behind a single address.

## Defects this dissolves

Both are live today, both are consequences of addressing queued work by position
while displaying it by id.

1. **Up-arrow is a dead key while a steer is pending.** `handleBoundaryArrow`
   returns unconditionally once `pendingQueuedMessages.length > 0`
   (`InputBox.tsx:784-797`), but `removeLastQueuedItem` inspects the *controller*
   queue, which is empty during a pending steer, so it resolves `null`. The
   keypress cancels nothing and also never reaches history navigation.
2. **Up-arrow can remove an item other than the one drawn last.** With a pending
   steer *and* a queued follow-up, `pendingQueuedMessages` holds both, but
   `removeLastQueuedItem` takes the controller tail — a different item than the
   bottom line the user is looking at.

Neither needs a separate fix. Addressing by id removes the class.

## Design

### 1. Run loop: retractable, editable pending steers

`ApplicationRunLoop.steer` currently returns `Promise<boolean>` where `false`
means "no boundary is coming, send it as its own turn". A retraction is a third
outcome — it must **not** fall through to a new turn — so the return widens to a
closed union rather than overloading `false`.

```ts
export type SteerOutcome = 'admitted' | 'released' | 'retracted';

steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome>;
/** Drop a waiting steer. False when it was already admitted. */
retractSteer(id: string): boolean;
/** Replace a waiting steer's items in place, keeping its position. */
editSteer(id: string, items: readonly ProviderInputItem[]): boolean;
```

`PendingSteer` gains an optional `id`. `#releasePendingSteers` resolves
`'released'`; `#admitPendingSteers` resolves `'admitted'`; `retractSteer`
splices and resolves `'retracted'`.

**The race is already closed and should be stated as an invariant.**
`#admitPendingSteers` (`application-run-loop.ts:295`) is synchronous and drains
the whole array at once; `retractSteer` is synchronous. They cannot interleave.
So: *a retraction is decided synchronously against `#pendingSteers`; once
admitted, the item is not retractable and `retractSteer` returns `false`.* The UI
must render that `false` — see `## Losing the race`.

Callers to widen for the union: `AgentClient.steer` (`agent-client.ts:371`),
`TurnWorkflow.steer` (`turn-workflow.ts:128`), `TurnCoordinator.steer`
(`turn-coordinator.ts:164`), `ConversationAdapter.injectIntoActiveTurn` /
`steerActiveTurn`. `injectIntoActiveTurn` has a second caller — background
subagent notifications (`mid-turn-injection.md`) — which passes no id and maps
`'admitted' → true`, everything else `→ false`. Keep its boolean signature; only
the user-steer path needs the union.

### 2. Adapter: one address, routed by stage

The adapter is the only object that can see both stages, so it owns the routing.
Two new methods, each returning a typed outcome instead of a bare boolean —
"it was already running" and "I have never heard of this id" are different
things and the UI says different words for them.

```ts
export type SubmissionStage = 'pending_steer' | 'queued' | 'started';

export type SubmissionMutation =
  | { kind: 'applied'; stage: 'pending_steer' | 'queued' }
  | { kind: 'too_late'; stage: 'started' }
  | { kind: 'unknown_id' };

retractSubmission(id: string): Promise<SubmissionMutation>;
editSubmission(id: string, turn: UserTurn): Promise<SubmissionMutation>;
```

The adapter tracks which ids it handed to `turnFlow.steer` and are still
unresolved (a small `#pendingSteerIds: Set<string>`, cleared when the steer
promise settles). Routing:

- id in `#pendingSteerIds` → `retractSteer` / `editSteer` on the run loop. A
  `false` return means it was admitted between render and keypress →
  `{ kind: 'too_late', stage: 'started' }`.
- id in the controller queue → `remove_queued` / `edit_queued`.
- id is the active execution's item → `too_late`.
- otherwise → `unknown_id`.

**Trap — `edit_queued` alone is not enough, and fails silently.** The controller
stores only `text`, but `#runQueuedTurn` executes `message?.input`
(`conversation-adapter.ts:505`), the `UserTurn` held in `#messagesById`. An
implementation that issues `edit_queued` and stops will redraw the new text and
send the old one. `editSubmission` must replace the `#messagesById` entry's
`input` *and* issue `edit_queued` with the new display text (keeping the
`QUEUED_NON_TEXT_PLACEHOLDER` substitution from `sendMessage`).

`removeLastQueuedItem` becomes a thin wrapper over `retractSubmission` for the
tail id, or is deleted once `InputBox` no longer uses it. Prefer deleting it —
its "last" semantics are defect #2.

**Editing does not change stage or position.** A steer edited in place stays a
steer at its slot in `#pendingSteers`; a queued item stays at its queue index,
keeping the steer-ahead-of-follow-ups ordering `QueueController.#submit`
(`queue-controller.ts:449-458`) established. Today's delete-then-retype loses
both — that is defect #2's other half.

### 3. Service, orchestrator, UI state

- `ConversationService`: forward `retractSubmission` / `editSubmission` next to
  the existing `removeLastQueuedItem` (`conversation-service.ts:321`).
- `ConversationOrchestrator`: `retractPendingSubmission(id)` and
  `editPendingSubmission(id, turn)`. On `applied` for a retract, dispatch
  `onQueuedMessageRemoved(id)`. On `applied` for an edit, a new
  `onQueuedMessageEdited(id, text)`. On `too_late`, leave UI state alone and let
  the caller report it. Drop the `onRemoveLastPendingMessage` fallback branch
  (`conversation-orchestrator.ts:326`) — it is the position-addressed path.
- Reducer: add `queue/message_edited` alongside the existing
  `queue/message_pending|started|removed` (`conversation-ui-reducer.ts:463-497`)
  and delete `queue/remove_last_pending`.

### 4. Interaction

The existing "⏳ Queued" block (`BottomArea.tsx:216-230`) becomes a selectable
list, `PendingQueueList`.

```
  ⏳ Queued  1. run the tests again
> ⏳ Queued  2. also update the README   [e]dit [d]elete
  ⏳ Queued  3. commit when green

  ▌ ▏
  ↑↓ select · e edit · d delete · esc back to input
```

**Entry keeps the current gesture.** ↑ on an empty input with items pending
selects the **bottom** item — exactly where today's up-arrow acts. From there:

- `↑` / `↓` move the selection. `↓` past the bottom returns focus to the input.
- `↑` past the top falls through into input history. The pending items and the
  history are one continuum walked backwards: not-yet-sent, then sent. This is
  what makes ↑ safe to overload, and it repairs defect #1 as a side effect —
  history is reachable again while items are pending.
- `e` or `Enter` — edit. Loads the item's text into the input box; the item
  **stays in the queue in its slot**, drawn dimmed. The prompt label becomes
  `edit 2 ▸ `. Enter replaces it in place; Esc cancels and restores the input.
- `d` — delete.
- `Esc` — back to the input box.

While the list has focus the input box does not, so plain letters are free.

No new `InputOwner` variant. The list lives inside the `showInput` branch and
the focus flag is `InputBox`-local, like the existing mode handlers — this is
why the inline surface was chosen over a modal: it does not have to participate
in the input-owner chain, and it stays visible while the turn streams.

**Truncation.** The 80-char preview is fine unselected; render the selected item
in full (wrapped) so `e` is not the only way to read what you queued.

### Losing the race

The user can press `d` in the same frame the run loop admits the steer. The
design does not prevent it — it reports it. On `{ kind: 'too_late' }` the item's
line is replaced with a one-shot notice (`already sent — the model has it`) and
the item moves into the transcript normally. For an edit that arrives too late,
the edited text is submitted as an ordinary new message rather than discarded;
the user typed it and meant it.

**A queued item being edited is not pinned.** If the active turn ends mid-edit,
the queue starts that item rather than stalling the agent on the user's typing.
The `too_late` path above covers it. Holding dispatch would let a half-finished
edit block the whole queue — the wrong trade.

## Not in scope

- **Reordering.** The steer-ahead-of-follow-ups rule already encodes an
  intent-based order. Delete-and-resubmit covers the rest. Revisit if asked.
- **Retracting an admitted steer.** The model has read it; the honest repair is
  another steer saying so, which the user can already send.
- **Persisting an edit's non-text payload.** `queueItemToPersisted`
  (`queue-controller.ts:268`) writes `text` only; images and skill attachments
  live in `#messagesById`, which is not persisted. An edit's text survives
  restart, added images do not. Pre-existing limitation of the queue, not
  introduced here.

## Rejected

- **Modal queue editor** (a `QueuePausedPrompt`-style prompt owning the
  keyboard). Costs a new `InputOwner` variant and blocks typing while open —
  wrong for a surface whose entire purpose is managing what you are about to
  type next.
- **Extend up-arrow recall to walk the whole queue.** Smallest diff, but every
  reach is destructive (pop then retype), so it cannot express "fix a typo in
  item 2" without losing item 2's slot and steer priority.
- **Overload `steer`'s `false` to mean retracted.** Silently turns a retraction
  into a brand-new turn — the exact opposite of what the user asked for.

## Build order

Each step is independently testable; steps 1–2 are the substrate and carry the
risk.

1. Run loop: `SteerOutcome` union, `id` on `PendingSteer`, `retractSteer` /
   `editSteer`. Widen the four callers.
2. Adapter: `#pendingSteerIds`, `retractSubmission` / `editSubmission`, the
   `#messagesById` write that `edit_queued` alone misses.
3. Service + orchestrator + reducer wiring; delete the obsolete
   `onRemoveLastPendingMessage` / `queue/remove_last_pending` path. Keep
   `removeLastQueuedItem` only as a temporary compatibility seam until Step 4
   rewires `InputBox` to the id-addressed `PendingQueueList`; then delete it.
4. `PendingQueueList` + `InputBox` selection mode and edit-in-place label.

## Testing

Per `AGENTS.md`, steps 1 and 2 touch the run loop and the adapter, so
`pnpm test:provider-black-box` runs **during** those steps, not at the end.

Unit coverage the design specifically calls for:

- `application-run-loop.test.ts` — retract before boundary resolves
  `'retracted'` and the item never reaches history; retract after admission
  returns `false`; edit in place preserves position among several pending
  steers; `abort` and `startStream` still release with `'released'`.
- `conversation-adapter.test.ts` — **the regression test for the trap**: after
  `editSubmission` on a queued item, the turn that eventually runs sends the new
  text. A test asserting only `queue.state()` would pass against the silent-fail
  implementation.
- `queue-controller.test.ts` — `edit_queued` gains its first real caller; check
  it survives a persist/restore round trip.
- `InputBox.test.tsx` — ↑ past the top of the list reaches history (defect #1);
  ↑ with a pending steer and a queued item selects the bottom line and mutates
  *that* id (defect #2).
