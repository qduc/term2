# Web transcript single source: build spec

Status: plan. This is the builder's contract for
[web-transcript-single-source.md](web-transcript-single-source.md); read that first for the evidence and the
decisions. Nothing below is implemented unless that document's "Resume here" says so.

Symbols named here were read on `main` at `6fcad34`. Check them with grep before relying on one.

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
| `src/protocol/fold/` | event and snapshot types; the only fold | import session, model, tools, host; format text for a UI |
| `src/host/server-sse.ts` | `direct-wire-v2` framing | reorder, drop or re-encode events |
| `web-client/lib/term2/session-store.ts` | connection, checkpoint, the current `WireSnapshot` | hold transcript rules |
| `web-client/lib/term2/present.ts` | every rule that turns a snapshot into `Term2SessionView` | read anything but its arguments; mutate them |
| React components | rendering a view | read `WireSnapshot` directly for transcript content |

A new wire field is consumed in `present.ts` only. A new event type is handled in `src/protocol/fold/` only; the
browser changes nothing.

## 2. Contracts

### 2.1 Stream format `direct-wire-v2`

Selected with `?format=direct-wire-v2`; the response carries `x-term2-event-format: direct-wire-v2`. The existing
`direct-wire-v1` and `agent-wire-v2` formats and their tests stay unchanged.

One SSE frame is one envelope:

```
{ format: 'direct-wire-v2', kind: 'accepted', sessionId, seq, occurredAt, events: WireEvent[], interaction? }
{ format: 'direct-wire-v2', kind: 'live',     sessionId,                  events: WireEvent[] }
{ format: 'direct-wire-v2', kind: 'snapshot', sessionId, seq,             events: [snapshot event], interaction }
```

- **Batch rule.** All events returned by one `DirectProjection.update()` call travel in one frame, in order. Events
  with a non-null `seq` form an `accepted` frame with `id: <seq>`; `seq: null` events form a `live` frame with no
  id. All events returned by one `synchronize()` call form one `snapshot` frame (its `error` / `turn_ended`
  companions ride in the same frame, before the snapshot event).
- **Do not infer batches from equal `seq` values or from the queue running empty.** `DirectEventQueue` receives the
  events of one update in a synchronous loop today, but that is an accident of three call sites
  (`in-process-direct-attachment.ts`, `in-process-direct-replay.ts`). Carry the boundary explicitly: let the queue
  accept a batch and expose batches to the SSE writer while single-event iteration keeps working for the TUI.
- **Modes.** No cursor: first frame is `snapshot` (the current cut N), then frames with `seq > N` and live frames.
  `after=N`: frames in `(N, toSeq]`, then one `snapshot` frame at `toSeq`, then live. This is what
  `directReplayView` already produces; the v2 encoder drops that snapshot, this format keeps it.
- **`interaction`.** The pending-interaction DTO as the v2 hydration body builds it today
  (`interactions.project` / `projectBudget`, with `subagent` for task owners), or `null`. Present on every
  `snapshot` frame and on any `accepted` frame containing `interaction_opened`, `interaction_resolved`,
  `budget_opened` or `budget_closed`, whether root or inside a `subagent` event. Absent means "unchanged". It is a
  term2 gateway field, not part of what graduates.
- **Failure.** Replay unavailable: HTTP 410 or `x-term2-replay: unavailable`, as now. An encoder that cannot build a
  frame fails the stream with the existing reload-required error; it never skips a frame.
- **BFF.** `web-client/app/api/agent/sessions/[sessionId]/events/route.ts` passes the new format through unchanged,
  with the same cursor validation.

Not carried over from the v2 encoder: its text caps (16 KB final text, 10 KB command error, 4 KB error message).
The native snapshot is already sent uncapped on load; view-side caps stay in `present.ts` (section 2.5). Changing
any cap value is out of scope and goes through the `guard-design` skill.

### 2.2 The fold boundary

- Move `reducer.ts`, `reducer-nested.ts`, `reducer-notices.ts`, `review-projection.ts`, the reducer's part of
  `turn-results.ts`, and the wire types (`wire.ts`, `wire-events.ts`, the types of `wire-commands.ts`) under
  `src/protocol/fold/`, leaving re-exports at the old paths so no other file changes.
- The folder imports nothing outside itself, type imports included. Today's leaks, each to be resolved inside the
  folder: `formatToolCommand` (via `protocol/json.ts` from `tools/conversation-utils.ts`), used once in
  `nestedPresentation` to build `WireTask.lastTool.label`; and type imports from `session/` and `model/` in
  `wire.ts`, `review-projection.ts` and `turn-results.ts`.
  - `lastTool.label` is UI wording inside the fold. Keep the field for the TUI, but have the fold take the formatter
    as a parameter with a default supplied by `src/protocol/`, so the folder itself carries no tool knowledge.
  - Replace imported types with structural declarations in the folder; the original modules assert assignability to
    them so drift is a compile error.
- **Gate.** `scripts/check-layers.mjs` checks edges between layers, not inside one. Add a rule beside it (in
  `scripts/check-rules.mjs`, with its reason text in `scripts/gates/rules.mjs`) that fails on any import leaving
  `src/protocol/fold/`, and show it red on a seeded import (`scripts/prove-checks.sh`).
- **Browser bundle.** A build step emits one ESM file from `src/protocol/fold/index.ts` into the web client (for
  example `web-client/lib/term2/generated/wire-fold.js` plus its `.d.ts`), run by `scripts/build-web.mjs` and by the
  web typecheck step. Direct source imports failed before under Turbopack's `.js` specifier resolution (see
  `web-client/WIRE.md`); the bundle sidesteps that. The spike measured 33 KB unminified. The generated file is
  not committed; CI builds it.

### 2.3 What the snapshot must gain

Only one field is missing for parity with what the web shows live today:

- **`reasoningBlocks?: readonly { messageId: string; turnId: string | null; modelStep: number | null; text: string }[]`**,
  appended by the `reasoning` event (upsert by `messageId`), cleared where `messages` is cleared
  (`session_rotated`, `history_replaced` without `retainTranscript`). `snapshotDirectState(state, previous)` carries
  it over from `previous` the way it carries `reasoningIdentity`; a cold attach gets it from the fact replay that
  `DirectAttachment` already runs before `synchronize`. The existing `reasoning` / `reasoningIdentity` fields stay
  for the TUI. Additive and optional, so `protocolVersion` stays 1.

Already present, so no change:

- **Per-turn usage**: sum `requestCosts[].record.usage` over receipts whose `rootTurnId` is the turn. No receipts
  for a turn means usage is unknown and nothing is shown (not zero).
- **Subagent cards**: `tasks[]` with `kind: 'subagent'` and `turnId` equal to the turn give role, name, input,
  status, `lastTool`, `toolCounts`, `progress` / `text` and `result` (`output`, `toolUseCounts`, `error`); the
  matching `branches[]` entry (by `taskId`) gives the card's tool list and usage.

If either turns out not to hold on a real session, add the missing data to the snapshot through the fold. Do not
reintroduce a browser-side accumulator.

### 2.4 `session-store.ts`

State: `{ sessionId, snapshot: WireSnapshot | null, interaction, phase, error }`, where `phase` is one of
`idle | connecting | live | reconnecting | reload_required | closed`.

| Input | Transition |
| --- | --- |
| `snapshot` frame, `seq >=` installed `seq` (or none installed) | replace `snapshot` and `interaction`; `phase = live` |
| `snapshot` frame with a lower `seq` | ignore |
| `accepted` frame, `seq <=` installed `seq` | ignore the whole frame |
| `accepted` frame, higher `seq` | fold every event, then publish once; apply `interaction` if present |
| `live` frame | fold every event, publish; the checkpoint does not move |
| a frame that fails to parse or fold | keep the last published state, close the stream, `phase = reload_required` |
| stream ends or errors | `phase = reconnecting`; reconnect with `after = snapshot.seq` |
| HTTP 410 or `x-term2-replay: unavailable` | `phase = reload_required` |
| frame for another session | protocol error, as above |

Publication is at most once per animation frame while the tab is visible, as `flushLiveView` does today; the fold
itself runs immediately. Expose the store through `useSyncExternalStore`. `useTerm2Session` keeps its current
return shape so components do not change in this phase.

There is no separate hydration GET: the first `snapshot` frame is the load.

### 2.5 `present.ts`

`present(snapshot, interaction, previous?) → Term2SessionView`. Pure, total over any valid snapshot, and it never
throws for unknown optional fields.

Rules, each written here once (they are today split between `contextTurns` in `hydration.ts` and
`applyAcceptedChange` in `event-adapter.ts`; where those two disagree the line says which wins):

1. A turn is the set of timeline entries whose message or tool has that `turnId`, in timeline order. Messages with
   no `turnId` and `role: 'tool'` messages are not transcript items.
2. With `timeline: null`: if there are no tools, message order is the order; otherwise no turns are presented and
   the view says ordering is unavailable.
3. The first user message of a turn, when nothing precedes it, is the opening bubble (`userText`,
   `userMessageId`). Any later user message with non-empty text is a `user` item at its timeline position (a
   steered message). *Hydration's rule wins.*
4. An assistant message with non-empty text is a `text` item carrying `id`, `draft`, `modelStep`. `turn.text` is
   those texts joined by a blank line. A message with `presentation.withdrawn` is not shown.
5. A tool with a call is a command: `callId = executionId`; status `called → pending`, `started → running`,
   `completed → failed` if `isError` else `completed`, `unknown → unknown`; `argumentsText` is the input string or
   its JSON; `output` or `error` from `output` by `isError`. One card per `executionId`. A result with no call stays
   in `unmatchedToolResults` and is not a card.
6. Turn status: the turn's `turnResults` entry gives `completed`, `aborted` (`cancelled` or `interrupted`) or
   `failed`; otherwise `streaming` if it is `activeTurnId` and the session is `running` or
   `awaiting_interaction`; otherwise `unknown`.
7. A failed turn shows `error` from one table mapping `WireError.kind` to the display reason (the table now
   duplicated in `hydratedErrorReason` and in the server's `errorReason`) and `errorMessage` from
   `error.message`, falling back to `terminal.error` when `terminal.turnId` matches.
8. Reasoning: each `reasoningBlocks` entry is a `reasoning` item placed before the first `text` item with the same
   `modelStep`; with no such item it goes last if the turn is streaming, else first. While `thinking` is true or
   `reasoning` holds text not yet in a block for the active step, show it as one streaming reasoning item.
9. Turn notes: `retry` gives `retrying (attempt a/b)` on the active turn; a compaction notice in progress gives
   `compacting context…`. Both vanish when the snapshot field does; `present` keeps no memory of them.
10. Per-turn usage and subagent cards as in section 2.3.
11. Session status: `idle → connected`; the other native statuses map by name; connection phases come from the
    store, not the snapshot.
12. Caps, unchanged values: 100,000 characters for any presented text, 4,096 for `errorMessage`, 10,000 for a
    command error.

**Reuse.** `present` returns the previous turn object when that turn's inputs are identical by reference (its
messages, tools, result, reasoning blocks, tasks, receipts, and whether it is the active turn). After one text
delta, exactly one turn object changes identity and `view.turns` is a new array of otherwise identical elements.

Deleted when this lands: `event-adapter.ts`, `native-state.ts`, the view half of `hydration.ts`
(`viewFromHydration`, `contextTurns`), and the view fields `hydration`, `nativeBranch`, `rootEvidence`,
`nativeState`, `nativeChanges`, `liveChanges`, `retiredTurns`. Components that read them
(`Term2NativeEvidence.tsx`, `Term2QueueBar.tsx`, `Term2RunningTasksPanel.tsx`, `Term2UsagePopover.tsx`,
`Term2SessionShell.tsx`) move to view fields that `present` fills from the snapshot. `queue.ts` and
`receipt-cost.ts` become functions of the snapshot.

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
  this", `text asst-2`; one command (`exec-1`, completed, output "a.txt\nb.txt"); status `completed`.
- Turn 2: `userText` "second prompt"; items `tool exec-2`; one command (failed, error "exit 1"); status `failed`,
  `error` `rate_limit`, `errorMessage` "429 slow down".
- After the two `text_delta` facts and before `asst-1`: turn 1 has one `text` item with `draft: true` and text
  "Let me look.", under the id the fold gives it.

Today's two browser paths disagree with this at 18 of 24 cuts: turn 1's reasoning is gone from the reload view once
turn 2 starts, and the live view has a second command card for `exec-1`.

## 4. Checks

| Check | Where | Shows |
| --- | --- | --- |
| `wire.snapshot-is-fold` | `scripts/generated-verification/wire.mjs` | Generated fact sequences (at most 30 facts, built from commands like the example: prompt, deltas, message, reasoning, tool call/start/finish, steer, usage, end as completed/failed/cancelled, a background task with a branch). Fold them through `DirectProjection.forReplay(...).update`, take `acceptedPart(snapshot)`, call `synchronize` with the session state folded from the same facts, take it again: equal. This is the server's own reload path, so it also guards the TUI |
| `wire.frames-round-trip` | same file | Encode the events as `direct-wire-v2` frames, JSON round-trip, decode and fold with the browser bundle: equals the server snapshot. Catches batching and JSON-shape loss |
| `web.present-reuse` | same file | `present` is deterministic, does not mutate its input, and after one more event changes the identity of at most the turns that event touched |
| Example in section 3 | gateway integration test beside `sse.integration.test.ts` | the expected view, reached by fold and by snapshot, through real HTTP SSE |
| Browser flows | `tests/web-client/browser/` | transcript before and after a reload, in a real browser |
| Web typecheck | `integration` lane | already added |
| Fold has no outgoing imports | `check-rules.mjs` | graduation stays possible |

`acceptedPart` removes the fields that only `seq: null` events write. Derive the list from the reducer, do not
guess; candidates read so far: `thinking`, `retry`, `reviewingApprovals`, `codexQuota`, `codexFiveHourQuota`,
`lastError`, tool progress text, `tasks[].lastObservation`, `tasks[].lastActivityAt`, and `reasoning` text that
arrived by `reasoning_delta`. If the property fails on a field that accepted facts write, that is a defect in
`snapshotDirectState` or the fold: fix it, do not add the field to the list.

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

**State** (user intent only): `selection` (`sessionId`, or a draft `{ workspaceId, config }`), the user's chosen
folder, composer (`input`, attachments, armed skill, history position), `stagedConfig`, `pendingFirstSend`,
retry and resend notices, panels and dialogs (`tasksPanelOpen`, `sidebarOpen`, `dialog`, `skillsOpen`), `pinned`,
and a `generation` counter bumped on every selection change.

**Derived at render, not stored**: `isDraft`, the effective folder (`chosen ?? open chat's folder ?? first saved`),
`sessionConfig` for the open chat, `stagedForChat`, `sendBlocked`, `composerDisabled`, the visible live status.
These replace the effects at TSX 458, 465, 885 and 1177, and the refs `prevInitialSessionId`,
`draftSessionIdRef`, `pendingFirstSendIdRef`, `alignmentRef`, `prevStatusRef`.

**Rules as transitions.** Each is one named case in `step`:

| Rule | Transition |
| --- | --- |
| Only the user opens or closes the running-tasks panel | `tasksPanelOpen` changes on `TASKS_PANEL_TOGGLED` and `TASKS_PANEL_CLOSED` and nowhere else |
| A chat is created on first send | `SEND_REQUESTED` in a draft emits `createSession`; `SESSION_CREATED` emits `applyConfig`; `CONFIG_APPLIED` plus stream `live` emits exactly one `submit` and clears `pendingFirstSend` |
| A new chat starts in the folder the user chose | `NEW_DRAFT(folder?)` records the folder from the user's action; `createSession` uses that value and nothing derived from the open chat |
| Sending waits for the live stream | no `submit` command while the stream phase is not `live` |
| Changing chat resets the composer, staging, pin and notices | done inside `SESSION_SELECTED` / `SESSION_LEFT`, except for a draft handing off to the chat it just created |
| Staged model and effort apply before the next send | `SEND_REQUESTED` with a stage emits `applyConfig` then `submit` |
| A failed send puts the text back | `SUBMIT_REJECTED` restores `input` and sets the resend notice |
| Notices drain once per accepted boundary | the store's boundary event emits `drainNotifications`; one retry after a busy answer |
| Post-tool status is delayed 400 ms | `TOOL_ROW_SETTLED` emits a timer command; `STATUS_TIMER_FIRED` reveals it |

**Commands** carry `{ sessionId, generation }`, and every result action echoes them. `step` drops a result whose
tag is not current. That one rule covers the late-response hazards the inventory found: `applySessionConfig`
resolving after a chat switch, `startDraftChat` half-failing and leaving a session behind, list refreshes
overwriting a just-created chat. Treat those three as hazards to reproduce first (the inventory inferred them by
reading, nobody has triggered them), and fix only what reproduces.

**Out of the hook.** `selectedWorkspaceId` and `selectSession` are user intent and move into the machine. The hook
keeps the connection, the lists and the request functions.

**Checks.**

- Generated property `shell.machine-rules` (`scripts/generated-verification/shell.mjs`): random action sequences
  of at most 30 steps, including late and out-of-order results. Invariants: the panel rule; exactly one `submit`
  per `SEND_REQUESTED` and never before `live`; `createSession` carries the user-chosen folder; a stale-tagged
  result leaves the state unchanged; after `SESSION_SELECTED` the composer is empty unless it is a handoff.
- A browser flow for each rule that has already cost a fix: the panel stays as the user left it across a turn
  with a background task (#394, #396); opening the page creates no chat and the first send creates one (#375); a
  new chat lands in the chosen folder while another chat is open (#389); send is disabled until the stream is
  attached (`a9de6e9`).

Do this phase in slices, one cluster per change (selection and draft first, then composer, then panels), each
leaving the shell working. Do not combine it with phase 2.

## 6. Do not

- Write a browser-side reducer, accumulator or event log, however small.
- Read `WireSnapshot` in a component for transcript content.
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
- `wire.snapshot-is-fold` moves with the fold as the library's stated guarantee.
- The package stays dependency-free and ESM-only, as its README promises.
- term2's `src/protocol/fold/` becomes a re-export of the pinned package, the way `@qduc/agent-core` is consumed.
