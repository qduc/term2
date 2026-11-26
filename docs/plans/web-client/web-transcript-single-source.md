# Web client: one source of truth for the transcript

Status: in progress. Design is settled and written down; phase 0 is partly on branch
`claude/beautiful-planck-2aliiz` (unmerged). Building is handed to a separate session.

## Resume here

- **Read next:** [the build spec](web-transcript-single-source-spec.md). It has the contracts, the acceptance
  example, the checks and what not to do.
- **On the branch:**
  - The dead v1 view path (`viewFromProjection`, `applyProjectionEvent`) and its unrun example test are deleted.
  - The `integration` CI lane typechecks `web-client` (shown failing on a seeded type error).
  - Six browser flows in `tests/web-client/browser/` (first send, tool call, failed turn, approval, reload
    mid-turn, steer), each comparing the transcript's accessibility tree before and after a reload. Run with
    `pnpm build && node scripts/build-web.mjs && pnpm test:web-browser`. They pass locally (about 14 s). The first
    three went red on a seeded reload-only regression in `Term2TurnTimeline.tsx`; each of the last three went red
    on its own seeded reload-only regression in `hydration.ts` (steered user item dropped, draft text dropped,
    pending interaction dropped).
  - The model double can hold a step (`hold` / `held()` / `release()`) so a flow acts while a turn runs, and it
    keys a steered message on the user's words, not the runtime's steering preamble. Steering only enters the
    running turn at a tool boundary: steered during a text-only reply, the message runs as the next turn.
  - A `web-browser` CI job, required by `port`. **It has never run on GitHub.** Its counted steps may exceed the
    120 s lane budget in `scripts/ci-budget.json`; if they do, shorten the lane first, and raise the budget only
    through the guard's own route.
- **Found by the flows, not yet fixed (phase 2 fixes it by construction):** token usage differs between live and
  reload. To reproduce, make the model double in `tests/web-client/browser/launch.ts` send a final chunk with
  `usage: { total_tokens: 1234 }` before `[DONE]`. Live, each reply shows "1,234 tokens" in its action row; after
  a reload that text is gone. After two turns (three provider requests) the composer chip shows 2.5k live and 3.7k
  after reload. The three flows stay green only because the double sends no usage. Keep them that way in the
  required lane; add the usage flow when phase 2 makes it pass.
- **The six unrun `node:test` files under `web-client/lib/` are gone** and `check-no-unit-tests.mjs` scans
  `web-client/` (shown red on a seeded file). Where their rules went:
  - Host, Origin and content-type guards, body validation (exact fields, opaque IDs, 16,384-character text, control
    characters), event and page cursors, and the settings-conflict details: `tests/web-client/browser/bff-guards.flow.ts`,
    against the real packaged BFF over raw HTTP. Red on four seeded regressions (packaged Host check off, Origin
    check off, text cap raised, conflict details dropped).
  - Aborting a stream before headers closes the gateway connection: `tests/host/gateway/bff-stream-abort.integration.test.ts`,
    over a real Unix socket. Red (timeout) with `req.destroy()` removed from the abort handler.
  - Dropped, with reasons: `chooseListenHost` and the `TERM2_WEB_CLIENT_ALLOWED_HOSTS` LAN opt-in only run under
    `pnpm dev` / `start` inside `web-client/`; the shipped `term2-web` binds `127.0.0.1` and clears the list
    (`scripts/build-web.mjs` launcher). The browser API client's normalizers (`validateCandidate`,
    `validateSelectedCandidate`, `validateSettings`) and `skipAuth` / `skipRetry` are exercised by every flow's
    folder pick and page load; their rejection of a malformed gateway reply is not checked anywhere now. Hiding
    `details` on non-conflict gateway errors is not checked either: no route can make the gateway return one.
- **Phase 1, done on the branch** (each item shown red on a seeded regression before it was trusted):
  - The fold lives in `src/protocol/fold/` (`wire-fold.ts`, `wire-types.ts`, `wire-events.ts`, `branch-fold.ts`, ...;
    the spec's `reducer.ts`/`wire.ts` were renamed because `check-rules` forbids duplicate basenames; `wire.ts`,
    `reducer.ts`, `review-projection.ts` and `turn-results.ts` stay as shims at the old paths, while the few
    importers of `reducer-nested`, `reducer-notices`, `wire-events` and `wire-commands` were pointed at the fold). The `fold-boundary` rule in `check-rules.mjs` fails on any import leaving it (four seeds in
    `prove-checks.sh`). Host-owned detail types are augmentation slots narrowed in `src/protocol/wire.ts`.
  - `scripts/build-web-fold.mjs` bundles `src/protocol/fold-browser.ts` (31 KB) with its `.d.ts` into
    `web-client/lib/term2/generated/`; `build-web.mjs`, the CI web typecheck and the CI generated-verification step
    run it. Nothing in the browser imports it yet.
  - Branch state is in the fold (`branch-fold.ts`): `DirectProjection` keeps its nested projections only to
    translate branch facts, and its snapshot is the fold's state. Before the old `branchSnapshots` was deleted,
    `wire.frames-round-trip` compared it with the new fold at every frame: 8,000 cases, equal. Parity goldens 9/9,
    `subagent-batch` included.
  - `direct-wire-v2`: `DirectEventQueue` carries one batch per publication (with an ordinal; `cut()` reads the
    snapshot and the last ordinal it contains together), `server-sse.ts` frames it, `server.ts` and the BFF events
    route accept it. The property caught a real bug while it was written: the opening snapshot frame was dropped as
    "already contained" by its own cut.
  - `wire.frames-round-trip` and `wire.snapshot-is-fold` in `scripts/generated-verification/wire.mjs`, green at
    seed 424242 (about 2 s and 4 s per 1,000 cases); `tests/host/gateway/direct-wire-v2.integration.test.ts` runs
    the acceptance example over real HTTP, including a publication between connect and the stream's cut.
  - Spec 2.3 (b) to (d): `reasoningBlocks`, `liveReasoning` and `turnUsage` in the fold (`fold/turn-detail.ts`),
    each carried over by `snapshotDirectState` (blocks while Session's timeline still has the reasoning entry,
    usage while the turn is known, live reasoning as is; all three start afresh on rotation).
    `wire.snapshot-is-fold` went red on the missing carry-over of each before it was added.
- **Independent verifier, phase 1: rejected** (on `87a5eef1`), with three defects, all fixed since:
  1. `eventStream`'s pre-live buffer counted every event since connect instead of what was still waiting, so a v1
     or agent-wire-v2 reader draining its opening snapshot under backpressure was dropped early. Fixed; a temporary
     probe (blocked opening write, 200 events, 150 drained, 100 more) disconnects before and not after. No
     persistent check covers this path.
  2. A branch's `acceptedSeq` no longer moves on a branch fact that projects to no event (a fold cannot see it).
     Nothing reads it; the contract (`wire-events.ts`, `protocol/mapping.md`) now says so.
  3. Session's timeline keeps reasoning entries through a rewind, so reasoning blocks of rewound turns survived a
     resync. `snapshotDirectState` now also requires the block's turn to still have messages. The generator now
     rewinds, and `wire.snapshot-is-fold` checks that rule after every rewind (red on the unfixed code).
  Also from the review: `fold-boundary` now catches `import x = require(...)` and triple-slash references (two more
  seeds), and the gateway test has the second example (a background subagent: branch values at two cuts, the
  panel's steps), red on the reviewer's seed "branch usage always shown", which nothing caught before.
- **Phase 2, done on the branch:** `session-store.ts` and `present.ts` behind `useTerm2Session` (same return
  shape); `event-adapter.ts`, `native-state.ts` and `hydration.ts` deleted; panels read `view.session`;
  `web.present-reuse` green (it found the fold rebuilding every tool object per tool event, fixed). All eight
  browser flows pass, including the new usage flow (per-reply counts and session total equal after a reload, no
  hydration request), which phase 0 had found red.
- **Independent verifier, second round** (on `c7bf7333`): phase 1 fixes accepted; phase 2 rejected with three
  findings, all fixed since:
  1. Reasoning drawn at the top of multi-step turns. A step's reasoning item arrives at completion, after the
     step's text streamed as a draft, so its anchor was the draft, which the final message then replaced. The fold
     now anchors before the step's own drafts and moves any anchor naming a replaced draft to its final message.
     `web.present-reuse` checks step order (a step's reasoning after earlier steps' text, before its own); red on the
     unfixed fold.
  2. A runtime fault (Session interrupted with an error, no accepted terminal) no longer reached the transcript.
     `present()` now shows it on the turn it interrupted: `failed`, the error's reason and message,
     `interruptedByFault` (rule 6 reads "aborted" only without such an error). Gateway test: a writer fault over
     the stream; red without it. The dead `transientFailure`/`subagents` reads are gone; the heartbeat's running
     subagent check reads `view.session.tasks`.
  3. Unit-style tests: the result-only case (a fixture fetched and passed to `present()`) is gone; an orphan
     result is now part of the stream test's acceptance script. The agent-wire-v2 steer and error tests keep their
     wire assertions only; the browser flows cover both views over `direct-wire-v2`.
  Also: the generator publishes Session state after each rewind, so `wire.snapshot-is-fold` compares again after
  it, and frames include mid-stream snapshots.
- **Known deviations, recorded:** accepted frames publish at once (as the old hook did), live deltas at most once
  per animation frame; while a history replacement is held, connection phases are not published either; the
  submit/abort overlays clear on any accepted frame; a pending request with no DTO shows the status line only, no
  card; a cancelled turn's running command reads `unknown`, because the fold settles `started` to `unknown` at turn
  end (as the old reload view did). No persistent check covers the pre-live SSE buffer path.
- **Independent verifier, round three** (on `53ec5fff`): **phase 2 accepted**, with no deviation blocking. Its one
  suggestion, a 401/403/404 arriving while a history replacement is held stays hidden, is fixed (the store releases
  the hold on a terminal error).
- **Phase 3, slice 1 (selection and draft), done on `claude/optimistic-brown-2d0lrp`** (stacked on the phases 0-2
  branch): `web-client/lib/term2/shell-machine.ts` holds the open chat (from `URL_CHANGED` only), the draft and its
  picks, the first send, the open chat's config and the staged model/effort. Commands run in one place in the
  shell; every result carries the `{ sessionId, generation }` it was issued under and a stale one is dropped. The
  effects at the old TSX 492 (config load), 885 (draft end) and 1032 (first send) and the refs
  `pendingFirstSendIdRef`'s setter, `draftSessionIdRef`'s draft role and the discovered-config state are gone; the
  page feeds `READY_TO_SEND` when the open chat is configured, unblocked and live.
  - Hazards, reproduced first in `tests/web-client/browser/shell-hazards.flow.ts`:
    1. **Reproduced:** an approval change for chat A that resolved after switching to chat B replaced B's config
       with A's, and B's model and approval chips disappeared. Fixed by the tag rule; red with it off.
    2. **Reproduced:** a first send whose settings write failed left its created chat behind, and sending again
       created a second chat. The draft now keeps the chat it created and a retry reuses it; red without that.
    3. **Not reproduced:** a chat list requested before the first send did not hide the created chat. The flow stays
       as a guard; no change was made for it.
  - `shell.machine-rules` (generated, `--target shell`): stale results change nothing, the shown config is the open
    chat's, `createSession` is for the chosen folder, a folder's unopened created chat is never followed by a second
    one, a created chat only joins a draft for its own folder, and a first message is sent once, only when ready.
    It found two more defects while it was written, both fixed: New chat during a first send dropped the created
    chat, and a draft discarded mid-send let its late result attach to the next draft (the generation now also moves
    on a new or discarded draft). The guard "no New chat while a first send runs" is now a second layer: removing it
    no longer shows in the property, because the late result is dropped as stale.
  - Rule flows: a new chat opens in the folder just chosen while another chat is open (#389); nothing can be sent
    before the chat's stream attaches (`a9de6e9`). Each red on a seeded regression. #375 is the existing first-send flow.
  - Not in this slice: `selectedWorkspaceId` still lives in the hook and the folder auto-select/alignment effects
    (old TSX 458, 465) and the composer reset (342) remain; they belong to the composer and panels slices.
- **Phase L (reminder, owner's decision 2026-11-26), done on this branch:** `scripts/gates/architecture-rules.mjs`
  (called from `check-rules.mjs`, reasons in `gates/rules.mjs`) holds the four rules: `fold-boundary` (moved here),
  `web-fold-imports`, `browser-owns-no-reducer` and `wire-fold-api-current`. `docs/contracts/wire-fold.api.txt` is
  generated by `scripts/wire-fold-api.mjs` (882 lines; the fold's exports plus the `direct-wire-v2` envelope).
  `Term2SessionFacts` moved into `present.ts` so `types.ts` no longer imports wire types. Each rule is red on a seeded
  violation in `prove-checks.sh`. `scripts/check-architecture-change.mjs` runs in the `quality` job and asks for the
  `architecture-change` label on a changed or removed report line, a deleted or emptied `wire.mjs`, `shell.mjs` or
  browser flow, or any change to the rules module; each case was exercised against a local base. `check-rules.mjs`
  now takes about six seconds (it builds a TypeScript program for the report).
- **Phase 3, slice 2 (composer), done on `claude/optimistic-brown-2d0lrp`:** the machine now also holds the message
  box (`input`, attachments, armed skill, history position, palette), its notices (resend, config, attachment), the
  message on its way, the transcript pin, the user's chosen folder, the delayed post-tool status and the
  background-notice drain. Gone: the composer reset effect (old TSX 342), the folder auto-select and alignment
  effects (458, 465; the folder in use is derived: an open chat's own folder, else the chosen one, else the first
  saved), the pin reset, the status-delay timer effect and the hook's drain effect (hook 563, now `BOUNDARY` fed
  from the shell). `selectedWorkspaceId` left the hook. A send is fixed when Send is pressed (`SEND_REQUESTED`):
  staged picks apply first unless a turn is running, then one `submit`; its outcome comes back tagged.
  - Hazards, reproduced first in `shell-hazards.flow.ts`:
    1. **Reproduced:** an Edit whose send answered after switching to chat B put chat A's text into B's message box
       with "the chat was rewound, but the message wasn't sent", although the server had accepted it for A. Fixed
       by the tag rule; the flow was red before the change.
    2. **Reproduced:** a rewind that restores its prompt, answering after Back to chat B, put A's prompt into B's
       message box. Fixed the same way.
  - `shell.machine-rules` gained: a chat change empties the composer and notices and drops a send in flight, except
    the handoff, which keeps the first message; staged picks apply before a message that starts a turn; one message
    on its way at a time, each submitted once, only to the open chat; a refused Edit or Retry gets its text back in
    its own chat; a stale image read or restored prompt changes nothing; a boundary is drained at most twice, the
    second only after a busy answer; a deferred status shows only after its own timer. Eight seeded regressions,
    each red (settling is weighted so the drain's retry chain is reached; a seed dropping only the `SUBMIT_SETTLED`
    tag check stays green because a chat change already drops the send, so that check is a second layer).
  - Flow: the post-tool status appears after its delay (#415), red with the timer command not run.
  - Behaviour changes, each deliberate: clicking the chat already open no longer clears the message box; a new or
    discarded draft also clears attachments and skill (before, only the text); signing in as another user also
    discards the draft; leaving a chat opened by URL (not from the list) falls back to the chosen or first saved
    folder rather than that chat's.
  - Not covered by a flow: the drain end to end (no flow has a background task finishing while idle; the property
    covers the rule and the command is the old request unchanged). The rewind dialog stays open across a Back to
    another chat; that is the panels slice.
- **Next:** phase 3 slice 3 (panels: `tasksPanelOpen`, `sidebarOpen`, `dialog`, `skillsOpen`).
  CI has not yet run any of this branch: the `web-browser` job's time budget is
  unproven. The acceptance example's steer is not in the stream integration test (it needs real queue state); the
  browser steer flow covers it end to end. The second example (a background subagent) was added in `c7bf7333`.
  Phase 3 is independent of 1 and 2.
- **Tooling trap:** CI pins pnpm 11.7.0. Adding a dependency with a newer local pnpm rewrites hundreds of
  lockfile lines; use the pinned version for dependency changes.

## Decisions

Owner, 2026-11-26:

- `@qduc/agent-wire` is to become a public library for building agent interface layers, so nobody has to reinvent
  this. The owner delegated the stream decision to the designer on that basis.
- Add `@playwright/test` (Chromium only) as a root dev dependency, in its own CI lane.
- Deliver by pushing to the working branch; the owner opens pull requests.
- This session designs and plans; another session builds.

- Once the architecture is settled, CI guards it so agents cannot break it without the owner's approval.
- Widen `scripts/check-no-unit-tests.mjs` to scan `web-client/`.

Designer, following from the first one:

- **The guards are reminders, sized for accidents.** The owner rejected a tamper-resistant lock as overkill:
  agents are not trying to get around the architecture, they step on it by mistake. So the guard is the existing
  gate pattern (a red check that explains itself) plus one label for changes the owner should see.
- **The browser folds native events with the shared reducer (option A below).** The package today ships the event
  vocabulary and envelope parsers and leaves state and replay to each application (its README says so). That is
  the part the web client reinvented, and the part a public library has to supply.
- **Incubate here, then graduate.** The fold and its types are isolated in `src/protocol/fold/` with no outgoing
  imports, used by the TUI and the web client, and later moved into `packages/wire` in qduc/agent-runtime as the
  next schema version, the way `@qduc/agent-core` graduated.
- **Split core from host extensions at graduation, not before.** The snapshot is term2-shaped today (goals,
  verification, Codex quota, queue pause reasons). The web client's `present.ts` will show which fields a UI
  reads; draw the line with that evidence.
- **The v2 change vocabulary is frozen.** Its encoder and tests stay for the external consumer; nothing new is
  added to it.
- **Reasoning summaries and per-turn usage survive a reload.** Today reasoning does only until the next turn
  starts, and the per-reply token count not at all.
- **Subagent activity stays in the running-tasks panel.** The transcript shows no subagent card, which is what
  happens today in practice.
- **The six `node:test` files under `web-client/lib/` that nothing runs** (`api/term2.test.ts` and five under
  `server/`): for each, check whether an integration test, release smoke or a browser flow already covers the
  behaviour; move what is uncovered and matters (the Host/Origin guard, cursor and request validation) into the
  gateway integration suite; then delete the files and make `scripts/check-no-unit-tests.mjs` scan `web-client/`.
  Deleting them without that check would drop the only written statement of those rules. (Done; see "Resume here".)

## What the code shows (2026-11-26, `main` at `6fcad34`)

Each line is labelled **verified** (ran it or read the named symbol) or **inferred**.

1. **The server already has the one fold.** `reduceWireEvent` in `src/protocol/reducer.ts` folds native
   `WireEvent`s into a `WireSnapshot`. `DirectProjection.update` keeps the server's own snapshot with it, and the
   TUI (`clients/tui/use-client.ts`), ACP (`clients/acp/attachment.ts`) and control client
   (`clients/control/control-session-port.ts`) all fold with the same function. *Verified.*
2. **The web client is the only client that does not use it.** On load it receives that native `WireSnapshot`
   (`viewFromHydration`). Live, it receives the same events re-encoded by `encodeAgentWireV2` /
   `canonicalCandidate` into an older vocabulary (`assistant_started`, `command_message`, `turn_completed`,
   `subagent_*`, …) and folds them with its own `applyAcceptedChange`. Two reducers over two vocabularies is where
   the copies come from; the third (`viewFromProjection`) has no production caller left. *Verified.*
3. **Reload and live disagree today.** A temporary probe drove one scripted session (prompt, reasoning, text,
   tool call and result, steered message, second turn that fails) through a real `DirectProjection` and compared
   `viewFromHydration(snapshot_N)` with the `applyTerm2Event` fold at every accepted cut: the turns differ at
   **18 of 24 cuts**. The classes: per-turn usage exists only live; an earlier turn's reasoning survives live but
   not reload once a later turn starts (the snapshot keeps one `reasoning` string); a tool result adds a second
   command card live only; streaming text has a different item id on each path. *Verified for this one script;
   the duplicate card may depend on the script writing both a `tool_finished` fact and a `tool_result` item.*
4. **Fix history agrees.** Of the 24 web fix commits, 5 carry a reload-versus-live sub-fix (3 reload-only, 2
   live-only), and #368, #418 and #420 each wrote the same rule twice with different code. 8 of 27 fixes
   (including three server-only ones) are "the TUI shows it, the gateway DTO drops it". 6 are effect races in
   `Term2SessionShell.tsx` / `useTerm2Session.ts`. *Verified by reading each diff.*
5. **CI does not look at the web client.** No explicit typecheck, no lint, no browser. It is compiled only as a
   side effect of `pnpm pack` in the `bench` lane; release smoke checks that the page and one API route answer.
   Seven `node:test` files under `web-client/` were run by nothing (all removed since). *Verified.*
6. **The shared fold fits in the browser.** `esbuild --bundle` of `src/protocol/reducer.ts` tree-shakes to 33 KB
   with no Node built-ins. A browser-platform build fails only at resolve time, because `reducer-nested.ts`
   imports `formatToolCommand` through `protocol/json.ts`, which also re-exports pricing code. *Verified.*
7. **The current reducer already breaks the performance rule.** `applyAcceptedChange` clones every turn on every
   accepted change; `liveChanges` and `nativeChanges` are append-only arrays copied on each event; and
   `presentTerm2SessionView` re-concatenates every reasoning delta on each render. *Verified by reading.*

## The two options considered

**A (chosen): fold native events with the shared reducer, like the TUI.**

```
SSE batch of WireEvent ─┐
                        ├─ reduceWireEvent ─▶ WireSnapshot ─▶ present() ─▶ Term2SessionView ─▶ React
snapshot (load, resync) ┘      (shared)                       (browser, the only transcript rules)
```

- The browser owns no reducer. A new event type is handled in `src/protocol/reducer.ts` for every client at once;
  a new field is read in one browser module, `present`.
- Reload equals live by construction: the snapshot the server sends *is* the server-side result of the same fold.
- The server gains one SSE encoding next to the two it has: the accepted/live batch envelope of v2 (one frame per
  accepted boundary, real `seq` and `occurredAt`) carrying native `WireEvent`s instead of re-encoded changes, and
  keeping the authoritative `snapshot` event that `directReplayView` already emits after a replay tail.
  `@qduc/agent-wire` does not change. The v2 encoder stays for the external consumer.
- What the snapshot lacks, it lacks for every client, so each gap is fixed once in `src/protocol`: per-turn
  reasoning, per-turn usage, subagent card detail.

**B: stay on agent-wire-v2 changes.** The browser keeps its own fold of about 50 change types into a normalized
store, with one presenter on top and a property comparing it with hydration. The rules are written once, but
agreement is only checked, not built in; the 18/24 baseline has to be worked down first; and every gap in the
re-encoded vocabulary needs a server change, sometimes a wire release and pin bump.

**Why A.** B keeps the cause (a second vocabulary and a second fold) and adds a detector. A removes the cause, and
the detector that is still needed becomes a server property that also protects the TUI. A's cost is that the
web client stops consuming the public v2 change vocabulary, so v2's encoder loses its in-repo consumer; its
gateway tests remain.

## Design in brief

The [build spec](web-transcript-single-source-spec.md) is the contract; this is the shape.

- **One fold, isolated.** `reduceWireEvent` and the wire types move under `src/protocol/fold/`, which imports
  nothing outside itself. The server, the TUI and the browser run the same code.
- **One stream format for the browser.** `direct-wire-v2`: the accepted/live batch envelope of v2 carrying native
  events, plus the authoritative snapshot frame the server already produces on connect and after a replay tail.
  The first snapshot frame is the page load, so the separate hydration request goes away.
- **Two browser modules.** `session-store.ts` owns the connection, the checkpoint and the current snapshot.
  `present.ts` is the only place a transcript rule is written, and it reuses unchanged turns so a streaming delta
  re-renders one turn.
- **Accepted versus live** is already encoded in the snapshot's shape (`draft`, `thinking`, `retry`), so there is
  no overlay layer. A reconnect drops live residue because the replay ends with the server's snapshot.
- **Replay rules** hold as stated in the brief: one cut then strictly-after replay on one connection; an older
  snapshot never replaces a newer one; unavailable replay or HTTP 410 shows "Reload required"; branch events
  reduce into `tasks` and `branches`, never the root transcript.
- **Shell policy** becomes one pure `step(state, action) → { state, commands }` module, with results tagged by
  session and generation so a late response cannot overwrite newer state.

## How it is checked

- **By construction:** the browser has no fold of its own, so a snapshot and a fold of the same events cannot
  disagree there. No property proves this; the spec's "Do not" list protects it.
- `wire.frames-round-trip`: generated fact sequences, sent as frames and folded by the browser bundle, equal the
  server's snapshot. It catches anything the server still holds outside the fold, and is red today as soon as a
  subagent branch exists.
- `wire.snapshot-is-fold`: the server's own resynchronisation does not change accepted state that the fold
  already produced. It guards the server's second producer (`snapshotDirectState`) and so the TUI as well.
- `web.present-reuse`, `shell.machine-rules`: see the spec.
- Browser flows in Chromium against the real gateway and a loopback model double, each asserting the transcript
  before a reload and again after it.
- Web typecheck in the `integration` lane (added).

The spec was checked against the code by an independent reviewer before handoff. Its first revision was wrong in
three places that would have blocked the build: subagent branch state is not in the shared fold at all, the
reasoning field could not be cleared or positioned as written, and image attachments had no rule. Revision 2
corrects those and ten smaller ones.

## Phases

| Phase | Change | Exit check | Risk |
| --- | --- | --- | --- |
| 0 | Web typecheck in CI (done); delete the dead v1 view path (done); browser flows for first send, tool call and failed turn, each asserted before and after reload; settle the six unrun test files | CI red on a seeded type error (shown) and on a seeded transcript regression | low |
| 1 | `src/protocol/fold/` with its no-imports gate; branch state moved into the fold; `reasoningBlocks`, `liveReasoning`, `turnUsage`; `direct-wire-v2` frames with explicit batches and empty accepted frames; browser bundle of the fold; `wire.frames-round-trip` and `wire.snapshot-is-fold` | both properties green at 1,000 runs (write `frames-round-trip` first and see it red on a branch); the gate red on a seeded import; a gateway integration test reads the new format; TUI goldens unchanged | high: it changes the state every client renders. Independent verifier |
| 2 | `session-store.ts` and `present.ts` behind the existing hook interface; delete `event-adapter.ts`, `native-state.ts` and the view half of `hydration.ts`; `web.present-reuse` | the spec's acceptance example holds by fold and by snapshot; every browser flow green, including the ones phase 0 found red; no hydration GET in the network log | high: independent verifier |
| 3 | `shell-machine.ts`: selection and draft, then composer, then panels | `shell.machine-rules` green; one browser flow per rule that already cost a fix | medium, in slices |
| L | Guard the settled architecture with reminders: static rules in `check-rules.mjs` with reason text, a generated report of the fold's public interface, and an `architecture-change` label check for the few changes the owner should see (spec section 8). After phase 2 | each rule red on a seeded violation in `prove-checks.sh`; the label check red on a changed line of the report and green on an added one | low |
| 4 | Graduate the fold into `@qduc/agent-wire` | the spec's graduation checklist | separate repo |

A flow that phase 0 finds red because reload and live really differ stays red-by-design until phase 2: record it
in this document with the evidence, keep the assertion, and do not land it in a required lane until it passes.

## Open, for the owner

- Whether the external consumer should move to the graduated library or stay on v2. Nothing here depends on it.
