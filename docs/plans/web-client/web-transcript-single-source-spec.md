# Web transcript single source: build spec

Status: plan. This is the builder's contract for
[web-transcript-single-source.md](web-transcript-single-source.md); read that first for the evidence and the
decisions. Nothing below is implemented unless that document's "Resume here" says so.

Symbols named here were read on `main` at `6fcad34`. Check them with grep before relying on one. An independent
reviewer checked revision 1 of this spec against the code; revision 2 (this one) folds in its findings. Where a
claim rests on that reviewer's probe and was not re-run by the author, it says "reviewer's probe".

## 1. Target

```
                    src/protocol/fold/  (no imports outside itself; graduates to @qduc/agent-wire)
                    ├─ wire types: WireEvent, WireSnapshot, …
                    └─ reduceWireEvent(state, event)
                                │ same code
        ┌───────────────────────┼─────────────────────────┐
   DirectProjection        TUI / ACP / control        web client
   (server snapshot)                                   session-store ─▶ present() ─▶ React
```

| Piece | Owns | Must not |
| --- | --- | --- |
| `src/protocol/fold/` | event and snapshot types; the only fold, branches included | import session, model, tools, host; format text for a UI |
| `src/host/server-sse.ts` | `direct-wire-v2` framing | reorder, drop or re-encode events |
| `web-client/lib/term2/session-store.ts` | connection, checkpoint, the current `WireSnapshot`, interaction DTOs | hold transcript rules |
| `web-client/lib/term2/present.ts` | every rule that turns a snapshot into `Term2SessionView` | read anything but its arguments; mutate them |
| React components | rendering a view | read `WireSnapshot` directly |

A new wire field is consumed in `present.ts` only. A new event type is handled in `src/protocol/fold/` only; the
browser changes nothing.

## 2. Contracts

### 2.1 Stream format `direct-wire-v2`

Selected with `?format=direct-wire-v2`; the response carries `x-term2-event-format: direct-wire-v2`. The existing
`direct-wire-v1` and `agent-wire-v2` formats and their tests stay unchanged. `withSession` in `src/host/server.ts`
and the BFF route `web-client/app/api/agent/sessions/[sessionId]/events/route.ts` both reject unknown formats today
and must accept this one; the BFF passes it through with the same cursor validation.

One SSE frame is one envelope:

```
{ format, kind: 'accepted', sessionId, seq, occurredAt, events: WireEvent[], interactions? }
{ format, kind: 'live',     sessionId,                  events: WireEvent[] }
{ format, kind: 'snapshot', sessionId, seq,             events: [...companions, snapshot event], interactions }
```

- **Batch rule.** All events returned by one `DirectProjection.update()` call travel in one frame, in order. A fact
  update returns only events with that fact's `seq` (an `accepted` frame, `id: <seq>`); a transient update returns
  one `seq: null` event (a `live` frame, no id); `synchronize()` returns its `error` / `turn_ended` companions and
  the snapshot event (one `snapshot` frame, whose `seq` is `payload.snapshot.seq`, since the event's own `seq` is
  null). The reviewer confirmed updates never mix the two kinds and no two updates share a `seq`.
- **Empty accepted frames.** Some facts project to no event (`display: false` items, `rollover_requested`,
  `effort_updates_rejected`, review-approved opens) but still advance the server's `seq`. Send an `accepted` frame
  with `events: []` for them so the client checkpoint equals the server's.
- **Carry the boundary explicitly.** A batch is `{ seq, occurredAt, events }` handed to `DirectEventQueue` as one
  unit by the two push sites (`in-process-direct-attachment.ts`, `in-process-direct-replay.ts`); single-event
  iteration keeps working for the TUI. Do not infer batches from equal `seq` values or from the queue running
  empty. `MAX_BUFFERED_EVENTS` in `eventStream` keeps counting events, not batches.
- **Modes.** No cursor: first frame is `snapshot` (the current cut N), then frames with `seq > N` and live frames.
  `after=N`: frames in `(N, toSeq]`, then one `snapshot` frame at `toSeq`, then live. `directReplayView` already
  produces this; the v2 encoder drops that snapshot, this format keeps it. On a live connection the server also
  sends a snapshot after a command that replaces history (`publishState()` after the command settles).
- **`interactions`.** A map from `requestId` to the pending-interaction DTO that `ServerInteractions.project` /
  `projectBudget` builds (with `subagent` for task owners).
  - On an `accepted` frame: one entry per `interaction_opened` or `budget_opened` in the frame, root or inside a
    `subagent` event, built from the event payload as `canonicalCandidate` does today.
  - On a `snapshot` frame: one entry per item in that snapshot's `pendingInteractions` and `pendingBudgets`, built
    from the snapshot event's own payload so the DTOs and the state are one cut.
  - Closing needs no entry: whether a request is still pending is read from the folded snapshot, which also drops
    requests on `turn_ended` and on `task_changed` with a result, where no `interaction_resolved` is sent.
  - It is a term2 gateway field, not part of what graduates.
- **Failure.** An encoder that cannot build a frame fails the stream with the existing reload-required error; it
  never skips a frame.
- **Check on connect.** A no-cursor connect reads the snapshot after the queue exists, so an event may be both in
  the snapshot and in the queue (the reviewer inferred this; it is not reproduced). Accepted duplicates are dropped
  by the checkpoint rule. Cover a connect during streaming in the integration test and fix the server if a live
  delta can be applied twice.

Not carried over from the v2 encoder: its text caps (16 KB final text, 10 KB command error, 4 KB error message).
The native snapshot is already sent uncapped on load; view-side caps stay in `present.ts` (section 2.5). Changing
any cap value is out of scope and goes through the `guard-design` skill.

### 2.2 The fold boundary

Move the fold and its types under `src/protocol/fold/`, leaving re-exports at the old paths so no other file
changes: `reducer.ts`, `reducer-nested.ts`, `reducer-notices.ts`, `reduceApprovalReview` / `withoutReview` from
`review-projection.ts`, `completedFinalText` from `turn-results.ts`, and the types in `wire.ts`, `wire-events.ts`
and `wire-commands.ts`.

The folder imports nothing outside itself, inline `import('…')` types included. Every edge that leaves the set
today, and what to do with it:

| Edge | Resolution |
| --- | --- |
| `reducer-nested.ts` → `formatToolCommand` (value, via `json.ts`), used once for `WireTask.lastTool.label` | the fold takes the formatter as a parameter; `src/protocol/` supplies the default, so the TUI keeps the label |
| `wire.ts` re-exports the runtime value `ASK_USER_NO_ANSWER_RESULT` from `tools/` | stays in the old-path shim, not in the folder |
| `wire.ts` → `ModelRequestCost` (`session/recovery-budget`, from `@qduc/agent-core`) | structural declaration in the folder; the original asserts assignability |
| `wire.ts` → `DirectFinalWindow` (`session/final.ts`, which pulls conversation items and `CommandMessage`) | opaque type in the folder; the fold never reads inside it |
| `wire.ts` → inline import of `shared/contracts/approval-review.js` | structural declaration |
| `wire-events.ts` → inline imports of `CodexWeeklyQuota` from `model/` | structural declaration |
| `review-projection.ts` → `DirectApprovalReviewTransient` | only `approvalReviewEvent` needs it; that function stays outside |
| `turn-results.ts` → `DirectSessionState`, values from `public.ts` | only `completedFinalText` moves |

- **Gate.** `scripts/check-layers.mjs` checks edges between layers, not inside one. Add a rule beside it (in
  `scripts/check-rules.mjs`, with its reason text in `scripts/gates/rules.mjs`) that fails on any import leaving
  `src/protocol/fold/`, inline type imports included, and show it red on a seeded import
  (`scripts/prove-checks.sh`).
- **Browser bundle.** A build step emits one ESM file from `src/protocol/fold/index.ts` into the web client (for
  example `web-client/lib/term2/generated/wire-fold.js` plus its `.d.ts`), run by `scripts/build-web.mjs` and by the
  web typecheck step. Direct source imports failed before under Turbopack's `.js` specifier resolution (see
  `web-client/WIRE.md`); the bundle sidesteps that. The spike measured 33 KB unminified. The generated file is
  not committed; CI builds it.

### 2.3 What the fold must gain

The fold is not yet the whole state transition. Four additions, all additive and optional so `protocolVersion`
stays 1, all in phase 1.

**a. Branches.** `reduceWireEvent` never writes `branches`: `DirectProjection` builds them from private nested
projections (`branchSnapshots` in `projection-parts.ts`), and the fold's `subagent` case updates `tasks[]` only. So
a client that folds events has `branches: []` while the server snapshot has the branch's tools and usage
(reviewer's probe). Move the reduction into the fold: a `subagent` event folds its child event into that branch's
state with the same reducer, and `branches` is a pure function of fold state. `DirectProjection.snapshot` then reads
what the fold holds, so its nested projections go away. The `subagent` payload already carries `branchId`,
`turnId`, `agentId`, `parentTurnId`, `rootTurnId` and `role`. This is the largest server change in the plan and
the TUI renders from the same state: its goldens must not change.

**b. `reasoningBlocks?: readonly { messageId; turnId; modelStep; text; after: { kind: 'message' | 'tool'; id } | null }[]`.**
Upserted by the `reasoning` event; `after` is the last timeline entry at that moment, or null. The existing
`reasoning` / `reasoningIdentity` fields stay for the TUI.

- The fold does not clear it on `history_replaced`: that event only adds a notice, and the dropped messages
  arrive with the snapshot that follows. So `snapshotDirectState(state, previous)` carries blocks over from
  `previous` and keeps only those whose `messageId` is still a reasoning entry in the session `state.timeline`
  (`session/state.ts` records them; `protocol/state.ts` filters them out of the public timeline). Without the
  filter, the blocks of rewound turns live forever.
- `session_rotated` clears it with `messages`.

**c. `liveReasoning?: string`**, live-only. Appended by `reasoning_delta`; reset by `reasoning`, `turn_started`,
`turn_ended` and `session_rotated`. Needed because `reasoning` cannot be split after the fact: the `reasoning`
event sets it to a summary and later deltas, which carry no message id or step, append to the same string.

**d. `turnUsage?: readonly { turnId; usage: WireUsage }[]`.** The last `usage` event of each turn, which is what
the live view shows per reply today. Carried over in `snapshotDirectState` like the blocks, kept for turns still in
`turnResults` or the timeline. Summing `requestCosts` by `rootTurnId` is not a substitute: it adds every model call
and every descendant subagent call, and a receipt's `usage` is optional.

Read from what is already there:

- **Context-window fill** (`Term2UsagePopover.tsx`): `snapshot.lastUsage.inputTokens`.
- **Session token total** (the composer chip): `snapshot.usage`.
- **Subagent detail** for the running-tasks panel: `tasks[]` (role, name, input, status, `lastTool`,
  `toolCounts`, `progress` / `text`, `result.output`, `result.toolUseCounts`, `result.error`) and, after (a), the
  matching `branches[]` entry by `taskId` for steps, turns and usage.

If something the UI shows turns out to have no source in the snapshot, add it to the fold. Do not reintroduce a
browser-side accumulator.

### 2.4 `session-store.ts`

State: `{ sessionId, snapshot: WireSnapshot | null, interactions: Map<requestId, Dto>, phase, error, held }`, where
`phase` is `idle | connecting | live | reconnecting | reload_required | closed`.

| Input | Transition |
| --- | --- |
| `snapshot` frame, `seq >=` installed `seq` (or none installed) | fold its events; replace `interactions` with the frame's; `held = false`; `phase = live`; publish |
| `snapshot` frame with a lower `seq` | ignore |
| `accepted` frame, `seq <=` installed `seq` | ignore the whole frame |
| `accepted` frame, higher `seq` | fold every event (none for an empty frame); merge the frame's `interactions`; drop DTOs whose request is no longer pending; publish once unless `held` |
| the frame contains `history_replaced` without `retainTranscript` | as above, then `held = true`: nothing is published until the next `snapshot` frame, as `clients/tui/use-client.ts` does |
| `live` frame | fold every event; publish unless `held`; the checkpoint does not move |
| resolve response of kind `next` (multi-question step) | replace that request's DTO; publish |
| a frame that fails to parse or fold; a frame for another session | keep the last published state, close the stream, `phase = reload_required` |
| stream ends or a network error | `phase = reconnecting`; reconnect with today's backoff, `after = snapshot.seq`, or no cursor when that is 0 or nothing is installed |
| HTTP 410 `cursor_compacted`, HTTP 503 `replay_unavailable`, or `x-term2-replay: unavailable` | `phase = reload_required`; no automatic retry |
| HTTP 401, 403, 404 | terminal error, as the hook treats them today |
| `refresh()` (user reload, the 409 path, the rewind fallback that calls `hydrateSession` today) | close the stream and connect with no cursor |

Publication is at most once per animation frame while the tab is visible, as `flushLiveView` does today; the fold
itself runs immediately. Expose the store through `useSyncExternalStore`. `useTerm2Session` keeps its current
return shape so components do not change in this phase.

There is no separate hydration GET: the first `snapshot` frame is the load, and it is the only way a cut is
installed. With diagnostics switched on, the store may keep the last 200 frames in a ring for the diagnostics
panel; nothing else reads it.

### 2.5 `present.ts`

`present(snapshot, interactions, previous?) → Term2SessionView`. Pure, total over any valid snapshot, and it never
throws for unknown optional fields.

Rules, each written here once. They are split today between `contextTurns` in `hydration.ts` and
`applyAcceptedChange` / `presentTerm2SessionView` in `event-adapter.ts`; where those disagree the line says which
wins. The reviewer confirmed rules 1 to 4, 6 and 7 match `contextTurns`.

1. A turn is the set of timeline entries whose message or tool has that `turnId`, in timeline order. Messages with
   no `turnId` and `role: 'tool'` messages are not transcript items.
2. With `timeline: null`: if there are no tools, message order is the order; otherwise no turns are presented and
   the view says ordering is unavailable.
3. The first user message of a turn, when nothing precedes it, is the opening bubble (`userText`,
   `userMessageId`, and the message's `content`, which carries image parts). Any later user message with non-empty
   text is a `user` item at its timeline position, also with `content` (a steered message). *Hydration's rule
   wins.* `userMessageId` is what rewind names.
4. An assistant message with non-empty text is a `text` item carrying `id`, `draft`, `modelStep`. `turn.text` is
   those texts joined by a blank line. A message with `presentation.withdrawn` is not shown.
5. A tool with a call is one command per `executionId`: `callId = executionId`; status `called → pending`,
   `started → running`, `completed → failed` if `isError` else `completed`, `unknown → unknown`; `argumentsText` is
   the input string or its JSON; `output` or `error` from `output` by `isError`. *Hydration's rule wins:* the live
   path's one card per command display message is dropped. In a turn that has a result, a tool still `called` or
   `started` is shown `failed` for a failed turn, `aborted` for a cancelled or interrupted one, and `unknown` for a
   completed one. A result with no call stays in `unmatchedToolResults` and is not a card.
6. Turn status: the turn's `turnResults` entry gives `completed`, `aborted` (`cancelled` or `interrupted`) or
   `failed`; otherwise `streaming` if it is `activeTurnId` and the session is `running` or
   `awaiting_interaction`; otherwise `aborted` if the session is `interrupted` and it is the last turn; otherwise
   `unknown`.
7. A failed turn shows `error` from one table mapping `WireError.kind` to the display reason (the table now
   duplicated in `hydratedErrorReason` and in the server's `errorReason`) and `errorMessage` from
   `error.message`, falling back to `terminal.error` when `terminal.turnId` matches.
8. Reasoning: each `reasoningBlocks` entry of the turn is a `reasoning` item placed directly after its `after`
   anchor, or first in the turn when the anchor is null or not in this turn. Non-empty `liveReasoning`, or
   `thinking` with nothing yet, is one streaming reasoning item at the end of the active turn.
9. Turn notes come only from snapshot fields: `retry` gives `retrying (attempt a/b)` on the active turn; a
   compaction notice in progress gives `compacting context…`. They vanish when the field does; `present` keeps no
   memory. Today's live path also shows `retries exhausted` and `compaction failed`: find the snapshot field or
   notice that carries each, or add one to the fold. Do not drop them silently.
10. Per-reply token count from `turnUsage`; a turn with no entry shows nothing, not zero. Subagent activity is
    shown by the running-tasks panel from `tasks` and `branches`. The transcript shows no subagent card, which is
    what happens today in practice: `Term2SessionShell.tsx` hides a card whenever a task descriptor exists for it.
11. Session status: `awaiting_interaction` whenever an interaction is presented (the fold does not set it for
    task-owned interactions or budgets); otherwise `idle → connected` and the other native statuses by name.
    Connection phases come from the store.
12. The presented interaction is the DTO for `pendingInteractions[0] ?? pendingBudgets[0]`. If the snapshot has a
    pending request with no DTO, show the request as pending and not answerable, never nothing.
13. `lastError` is a session-level error (kind and message) on the view. It replaces the live-only
    `transientFailure` overlay: in this stream a runtime fault arrives with the snapshot that already has status
    `interrupted`. This is the designer's reading of that path; reproduce a writer fault or a restart mid-turn
    before settling the wording.
14. Caps, unchanged values: 100,000 characters for any presented text, 4,096 for `errorMessage`, 10,000 for a
    command error.

**Reuse.** `present` returns the previous turn object when that turn's inputs are identical by reference (its
messages, tools, result, reasoning blocks, usage entry, and whether it is the active turn). After one text delta,
exactly one turn object changes identity and `view.turns` is a new array of otherwise identical elements.

**Deleted when this lands:** `event-adapter.ts`, `native-state.ts`, the view half of `hydration.ts`
(`viewFromHydration`, `contextTurns`), and the view fields `hydration`, `nativeBranch`, `rootEvidence`,
`nativeState`, `nativeChanges`, `liveChanges`, `retiredTurns`. Components that read them move to view fields that
`present` fills from the snapshot: `Term2TurnTimeline.tsx` and `Term2SessionShell.tsx` (message `content` for
`Term2UserContent`), `Term2NativeEvidence.tsx`, `Term2QueueBar.tsx`, `Term2RunningTasksPanel.tsx`,
`Term2UsagePopover.tsx`. `queue.ts` and `receipt-cost.ts` become functions of the snapshot.

**Intended losses, to list in the change description:** the raw accepted-change log in the diagnostics panel (it
becomes the frame ring from section 2.4); `retiredTurns` placeholders after `session_rotated` (the snapshot is
authoritative about what the session holds); one card per command display message (rule 5). Anything else that
disappears is a defect: compare screenshots of each component before and after on the same session.

## 3. Acceptance example

The session the probe used. Facts, in order:

1. `queue_submitted`, `queue_started`, `turn_started` for prompt "first prompt" (turn 1)
2. live `reasoning_delta`; `item` reasoning `rs-1` "Plan: read the file." (step 1)
3. `text_delta` "Let me " and "look."; `item` assistant `asst-1` "Let me look." (step 1)
4. `item` tool_call (`exec-1`, shell, `ls`); `tool_started`; `tool_finished` "a.txt\nb.txt"; `item` tool_result
5. `usage` 100 in / 20 out
6. `queue_submitted` with `delivery: 'steer'` "also check this"; the boundary plan that steers it
7. `item` assistant `asst-2` "Two files." (step 2); `turn_ended` completed
8. Second prompt "second prompt" (turn 2); tool_call `exec-2` `false`; `tool_started`; `tool_finished` "exit 1"
   with `isError`; `turn_ended` failed with `{ kind: 'rate_limit', message: '429 slow down' }`

Expected view at the end, whichever way the snapshot was reached:

- Turn 1: `userText` "first prompt"; items `reasoning rs-1`, `text asst-1`, `tool exec-1`, `user` "also check
  this", `text asst-2`; one command (`exec-1`, completed, output "a.txt\nb.txt"); usage 100 in / 20 out; status
  `completed`.
- Turn 2: `userText` "second prompt"; items `tool exec-2`; one command (failed, error "exit 1"); status `failed`,
  `error` `rate_limit`, `errorMessage` "429 slow down".
- After the two `text_delta` facts and before `asst-1`: turn 1 has one `text` item with `draft: true` and text
  "Let me look.", under the id the fold gives it.
- After step 2's live delta and before `rs-1`: turn 1 ends with one streaming reasoning item.

Today's two browser paths disagree with this at 18 of 24 cuts: turn 1's reasoning and usage are gone from the
reload view, and the live view has a second command card for `exec-1`.

Add a second example with a background subagent (a `branch_started` and three `branch_event`s, one a tool call):
the running-tasks panel's steps for that task are the same by fold and by snapshot. It fails until 2.3(a) lands.

## 4. Checks

What makes reload equal live in the browser is that the browser has no fold of its own: that is by construction,
and no property proves it. The properties guard the places where two producers still exist.

| Check | Where | Shows |
| --- | --- | --- |
| `wire.frames-round-trip` | `scripts/generated-verification/wire.mjs` | Generated fact sequences (at most 30 facts, built from commands like the examples: prompt, deltas, message, reasoning, tool call/start/finish, steer, usage, end as completed/failed/cancelled, a branch with child events, a silent fact). Encode as `direct-wire-v2` frames, JSON round-trip, fold with the browser bundle: equals the server's snapshot, `seq` included. Catches batching, empty frames, JSON-shape loss and anything the server holds outside the fold; it is red today as soon as a branch exists |
| `wire.snapshot-is-fold` | same file | After folding, call `synchronize` with the session state built from the same facts (`initialDirectState` + `reduceDirectFact` in `session/state.ts`; no Session needed): `acceptedPart` is unchanged. Compare only at cuts that are not between a non-retain `history_replaced` and its snapshot, where the fold is stale by design. It is a real check for fields `snapshotDirectState` rebuilds from session state and for the carry-over filters of 2.3; for fields merely copied from `previous` it compares a value with itself |
| `web.present-reuse` | same file | `present` is deterministic, does not mutate its input, and after one more event changes the identity of at most the turns that event touched |
| Examples in section 3 | gateway integration test beside `sse.integration.test.ts` | the expected views, by fold and by snapshot, through real HTTP SSE; includes a connect while a turn is streaming |
| Browser flows | `tests/web-client/browser/` | transcript before and after a reload, in a real browser; add usage and reasoning flows when phase 2 makes them pass |
| Web typecheck | `integration` lane | already added |
| Fold has no outgoing imports | `check-rules.mjs` | graduation stays possible |

`acceptedPart` removes every field whose value can depend on a `seq: null` event. Derive the list from the reducer,
do not guess; candidates read so far: `thinking` (set live, reset by accepted events), `retry`,
`reviewingApprovals`, `codexQuota`, `codexFiveHourQuota`, `lastError`, `liveReasoning`, `reasoning`, tool progress
text, and `tasks[].lastObservation` / `lastActivityAt` / `progress`. If a property fails on a field that only
accepted facts write, that is a defect in `snapshotDirectState` or the fold: fix it, do not add the field to the
list.

Bounds for the generated properties follow `docs/experiments/generated-verification/README.md`: 1,000 cases, at
most 30 actions, no model or network, about 30 seconds per target. Register the target in
`scripts/generated-verification/run.mjs`.

## 5. Shell policy (phase 3)

`Term2SessionShell.tsx` has 20 effects and `useTerm2Session.ts` 3. Of those, 8 only copy or reset state when
other state changes (TSX 342, 404, 458, 465, 885, 1177, part of 492; hook 158), and 2 turn state into a command
(TSX 1032 first send; hook 563 notice drain). Those ten are where the six effect-race fixes landed. The rest
(fetch on mount, scroll, textarea height, visibility, keyboard, animation) are fine as effects and stay.
Line numbers are from `6fcad34`; the symbols are the stable reference.

**Module.** `web-client/lib/term2/shell-machine.ts`: `step(state, action) → { state, commands }`, pure, no React.
The shell holds it with `useReducer` and runs the returned commands in one place.

**The URL owns which chat is open.** `Term2Entry.tsx` reads `agentSession` and passes it as `initialSessionId`;
the shell mirrors it and several handlers write history and dispatch `popstate`. Keep one owner: `URL_CHANGED` is
the only action that changes the open chat, and handlers that want to change it emit a `navigate` command. The
machine does not store a second copy that can disagree with the address bar.

**State** (user intent only): the open chat as last reported by `URL_CHANGED`, or a draft
`{ workspaceId, config }`; the user's chosen folder; composer (`input`, attachments, armed skill, history
position); `stagedConfig`; `pendingFirstSend`; retry and resend notices; panels and dialogs (`tasksPanelOpen`,
`sidebarOpen`, `dialog`, `skillsOpen`); `pinned`; and a `generation` counter bumped on every `URL_CHANGED`.

**Derived at render, not stored**: `isDraft`, the effective folder (`chosen ?? open chat's folder ?? first saved`),
`sessionConfig` for the open chat, `stagedForChat`, `sendBlocked`, `composerDisabled`, the visible live status.
These replace the effects at TSX 458, 465, 885 and 1177, and the refs `draftSessionIdRef`,
`pendingFirstSendIdRef`, `alignmentRef`, `prevStatusRef`.

**Rules as transitions.** Each is one named case in `step`:

| Rule | Transition |
| --- | --- |
| Only the user opens or closes the running-tasks panel | `tasksPanelOpen` changes on `TASKS_PANEL_TOGGLED` and `TASKS_PANEL_CLOSED` and nowhere else |
| A chat is created on first send | `SEND_REQUESTED` in a draft emits `createSession`; `SESSION_CREATED` emits `applyConfig` and `navigate`; once `URL_CHANGED` names that chat, its config is loaded, `sendBlocked` is false and the stream is `live`, emit exactly one `submit` and clear `pendingFirstSend` |
| A new chat starts in the folder the user chose | `NEW_DRAFT(folder?)` records the folder from the user's action; `createSession` uses that value and nothing derived from the open chat |
| Sending waits for the live stream | no `submit` command while the stream phase is not `live` |
| Changing chat resets the composer, staging, pin and notices | done inside the `URL_CHANGED` transition, except for a draft handing off to the chat it just created |
| Staged model and effort apply before the next send | `SEND_REQUESTED` with a stage emits `applyConfig` then `submit` |
| A failed send puts the text back | `SUBMIT_REJECTED` restores `input` and sets the resend notice |
| Notices drain once per accepted boundary | a `BOUNDARY(seq, pendingNoticeIds, ready)` action fed from the store emits `drainNotifications`; one retry after a busy answer |
| Post-tool status is delayed 400 ms | `TOOL_ROW_SETTLED` emits a timer command; `STATUS_TIMER_FIRED` reveals it |

**Commands** carry `{ sessionId, generation }`, and every result action echoes them. `step` drops a result whose
tag is not current. That one rule covers the late-response hazards the inventory found: `applySessionConfig`
resolving after a chat switch, `startDraftChat` half-failing and leaving a session behind, list refreshes
overwriting a just-created chat. Treat those three as hazards to reproduce first (the inventory inferred them by
reading, nobody has triggered them), and fix only what reproduces.

**Out of the hook.** `selectedWorkspaceId` is user intent and moves into the machine; `selectSession` becomes the
`navigate` command. The hook keeps the connection, the lists and the request functions.

**Checks.**

- Generated property `shell.machine-rules` (`scripts/generated-verification/shell.mjs`): random action sequences
  of at most 30 steps, including late and out-of-order results. Invariants: the panel rule; exactly one `submit`
  per `SEND_REQUESTED` and never before `live`; `createSession` carries the user-chosen folder; a stale-tagged
  result leaves the state unchanged; after `URL_CHANGED` to another chat the composer is empty unless it is a
  handoff.
- A browser flow for each rule that has already cost a fix: the panel stays as the user left it across a turn
  with a background task (#394, #396); opening the page creates no chat and the first send creates one (#375); a
  new chat lands in the chosen folder while another chat is open (#389); send is disabled until the stream is
  attached (`a9de6e9`).

Do this phase in slices, one cluster per change (selection and draft first, then composer, then panels), each
leaving the shell working. Do not combine it with phase 2.

## 6. Do not

- Write a browser-side reducer or accumulator, however small. The diagnostics frame ring is the one exception and
  nothing may read state from it.
- Read `WireSnapshot` in a component.
- Change `@qduc/agent-wire`, the v2 encoder, or what the TUI renders.
- Change a cap value, a timeout or a retry limit.
- Add a permanent unit test. The checks above are integration tests, browser flows or generated properties.
- Weaken a check to get green. A reload difference a flow finds is a finding: report it.

## 7. Graduation checklist (later, in qduc/agent-runtime)

- `src/protocol/fold/` passes its no-imports gate and has had two consumers with different UIs (TUI and web) for
  at least one release.
- The web client's `present.ts` shows which snapshot fields a UI reads. Fields only term2 uses (goal,
  verification, Codex quota, queue pause reasons, admissions, command receipts) are candidates for a host
  extension slot; decide the split then, with that evidence.
- `wire.frames-round-trip` and `wire.snapshot-is-fold` move with the fold as the library's stated guarantees.
- The package stays dependency-free and ESM-only, as its README promises.
- term2's `src/protocol/fold/` becomes a re-export of the pinned package, the way `@qduc/agent-core` is consumed.

## 8. Guarding the settled architecture (phase L)

The guard is a reminder. An agent that steps on one of these rules by accident should get a red check that says
which rule, why it exists and what to do instead. It is not a defence against someone trying to get around it,
so it uses the repository's existing gate pattern and nothing new on the GitHub side.

**Static rules**, added to `scripts/check-rules.mjs` with their reason text in `scripts/gates/rules.mjs` (the text
a failing gate prints: why the rule exists, the usual fix, the moves that only satisfy the check, how to record a
deviation):

- Nothing under `src/protocol/fold/` imports from outside it. *Why: it has to be able to move into
  `@qduc/agent-wire`.*
- Under `web-client/`, only `lib/term2/session-store.ts` imports the fold bundle, and only it and `present.ts`
  import wire types; components import neither. *Why: a second place that folds events or reads the snapshot is
  how reload and live came to disagree.*
- `web-client/lib/term2/event-adapter.ts` and `native-state.ts` do not exist. *Why: the browser owns no reducer.*
- `docs/contracts/wire-fold.api.txt` is up to date. It is a generated, sorted, one-member-per-line report of what
  `src/protocol/fold/index.ts` exports plus the `direct-wire-v2` envelope, so a change to the future library's
  interface shows up as a diff in a file the owner can read.

Each rule is shown red on a seeded violation in `scripts/prove-checks.sh`, like the existing ones.

**Owner's eyes on the changes that matter.** One small check in the `quality` job,
`scripts/check-architecture-change.mjs`, modelled on `check-ci-budget.mjs`. It asks for the `architecture-change`
pull-request label when a pull request does any of these:

- changes or removes an existing line of `wire-fold.api.txt` (added lines pass: a new optional field or event type
  needs no approval);
- deletes or empties `scripts/generated-verification/wire.mjs`, `shell.mjs` or a file under
  `tests/web-client/browser/`;
- adds an exception for one of the rules above.

Its failure message says what was touched, why it is guarded, and to stop and ask the owner rather than add the
label oneself. That is the same convention as `golden-change` and `ci-budget-change`.

**The checks that already run stay the guard for behaviour:** the generated properties, the browser flows and the
gateway integration test. Nothing extra protects them beyond the deletion rule above and the repository's
standing rule against weakening a check.

Put this in when phase 2 has met its exit check. It is one change, not a programme.
