# Web client: one source of truth for the transcript

Status: in progress. Design is settled and written down; phase 0 is partly on branch
`claude/beautiful-planck-2aliiz` (unmerged). Building is handed to a separate session.

## Resume here

- **Read next:** [the build spec](web-transcript-single-source-spec.md). It has the contracts, the acceptance
  example, the checks and what not to do.
- **On the branch:**
  - The dead v1 view path (`viewFromProjection`, `applyProjectionEvent`) and its unrun example test are deleted.
  - The `integration` CI lane typechecks `web-client` (shown failing on a seeded type error).
  - Three browser flows in `tests/web-client/browser/` (first send, tool call, failed turn), each comparing the
    transcript's accessibility tree before and after a reload. Run with
    `pnpm build && node scripts/build-web.mjs && pnpm test:web-browser`. They pass locally (about 9 s) and went red
    on a seeded reload-only regression in `Term2TurnTimeline.tsx`.
  - A `web-browser` CI job, required by `port`. **It has never run on GitHub.** Its counted steps may exceed the
    120 s lane budget in `scripts/ci-budget.json`; if they do, shorten the lane first, and raise the budget only
    through the guard's own route.
- **Found by the flows, not yet fixed (phase 2 fixes it by construction):** token usage differs between live and
  reload. To reproduce, make the model double in `tests/web-client/browser/launch.ts` send a final chunk with
  `usage: { total_tokens: 1234 }` before `[DONE]`. Live, each reply shows "1,234 tokens" in its action row; after
  a reload that text is gone. After two turns (three provider requests) the composer chip shows 2.5k live and 3.7k
  after reload. The three flows stay green only because the double sends no usage. Keep them that way in the
  required lane; add the usage flow when phase 2 makes it pass.
- **Next:** the approval, reload-mid-turn and steer flows; settle the six unrun test files; then phase 1. Phases
  are in order; 3 is independent of 1 and 2 and can be scheduled separately.
- **Tooling trap:** CI pins pnpm 11.7.0. Adding a dependency with a newer local pnpm rewrites hundreds of
  lockfile lines; use the pinned version for dependency changes.

## Decisions

Owner, 2026-11-26:

- `@qduc/agent-wire` is to become a public library for building agent interface layers, so nobody has to reinvent
  this. The owner delegated the stream decision to the designer on that basis.
- Add `@playwright/test` (Chromium only) as a root dev dependency, in its own CI lane.
- Deliver by pushing to the working branch; the owner opens pull requests.
- This session designs and plans; another session builds.

Designer, following from the first one:

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
  Deleting them without that check would drop the only written statement of those rules.

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
   Seven `node:test` files under `web-client/` are run by nothing. *Verified.*
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
| 4 | Graduate the fold into `@qduc/agent-wire` | the spec's graduation checklist | separate repo |

A flow that phase 0 finds red because reload and live really differ stays red-by-design until phase 2: record it
in this document with the evidence, keep the assertion, and do not land it in a required lane until it passes.

## Open, for the owner

- Whether the external consumer should move to the graduated library or stay on v2. Nothing here depends on it.
- Whether `check-no-unit-tests.mjs` may be widened to `web-client/` (it tightens a repository guard).
