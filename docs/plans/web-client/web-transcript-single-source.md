# Web client: one source of truth for the transcript

Status: in progress. Phase 0 is partly on branch `claude/beautiful-planck-2aliiz` (unmerged); phases 1-3 wait on
decision D1, which the owner asked to talk through before choosing.

## Resume here

- Done on the branch: the dead v1 view path (`viewFromProjection`, `applyProjectionEvent`) and its unrun example
  test are deleted; the `integration` CI lane typechecks `web-client` (shown failing on a seeded type error).
- Next, independent of D1: the browser flows listed under "How it is checked".
- Blocked on D1: everything in phases 1-3.

## Decisions (owner, 2026-11-26)

- Add `@playwright/test` (Chromium only) as a root dev dependency, in its own CI lane.
- Deliver by pushing to the working branch; the owner opens pull requests.
- D1 (which stream the browser folds): open, but the owner stated the goal that decides it: `@qduc/agent-wire`
  is to become a public library for building agent interface layers, so that nobody has to reinvent this. The
  package today ships the event vocabulary and envelope parsers and leaves state and replay to each application
  (its README says so), which is the part the web client reinvented. Proposed reading, not yet confirmed: option A,
  with the state shape and `reduceWireEvent` incubated here and then graduated into `packages/wire` in
  qduc/agent-runtime as the next schema version, the way `@qduc/agent-core` graduated; the web client consumes
  them from the package. Open with it: whether the snapshot is published term2-shaped or split into a portable
  core plus host extensions first.

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

## Decision D1: which stream the browser folds

**A (recommended): fold native events with the shared reducer, like the TUI.**

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

## Design under A

**Browser modules** (`web-client/lib/term2/`):

- `session-store.ts`: owns `{ snapshot: WireSnapshot, connection }`. Applies one batch atomically; ignores an
  accepted batch at or below `snapshot.seq`; ignores a `snapshot` event older than the installed one; turns HTTP
  410 or `x-term2-replay: unavailable` into "Reload required". Exposed through `useSyncExternalStore`.
- `present.ts`: pure `WireSnapshot → Term2SessionView`. Memoized per turn on the identity of that turn's
  messages, tools and result, so a streaming delta re-presents one turn and React re-renders one turn.
- The shared fold arrives as a build-time bundle of `src/protocol/reducer.ts`; types are imported from
  `src/protocol/wire.ts`.
- Deleted: `event-adapter.ts`, the view half of `hydration.ts`, `native-state.ts`, `nativeChanges`, `liveChanges`.

**Accepted versus live.** The native snapshot already separates them by shape: a streaming message has
`draft: true`, and `thinking`, `retry` and tool progress are fields the accepted facts overwrite. No overlay layer
is needed. `acceptedPart(snapshot)` strips those fields; it is used by the property below and nowhere at runtime.
A reconnect discards live residue because the replay tail ends with the server's authoritative snapshot.

**Replay rules.** Hydrate once then replay strictly after N: the load is a snapshot at N followed by batches
`> N` on one connection. Older cut never replaces newer: guarded in `session-store`. Fail closed: unchanged.
`history_replaced`: the reducer handles it and the server follows with a snapshot. Branch streams never touch the
root transcript: `subagent` events reduce into `tasks` and `branches`, which `present` reads separately.

**Interactions.** The pending-interaction DTO (choices, multi-question progress) is built by `ServerInteractions`
and is not in the snapshot. Phase 2 keeps it as a sidecar field on the batch that opens or closes an interaction;
moving the form state into the browser is a later, separate change.

**Caps.** The v2 encoder's wire caps (16 KB final text, 10 KB error) stop applying to this stream; the 2 MB
hydration budget and the presenter's 100 KB / 4 KB view caps stay. Any change to a cap goes through `guard-design`.

## How it is checked

- **Generated property `wire.snapshot-is-fold`** (`scripts/generated-verification/`, seed 424242): for generated
  fact sequences of at most 30 facts, at every cut N,
  `acceptedPart(snapshot of a cold replay to N) ≡ acceptedPart(reduceWireEvent fold of events 1..N)`. This is the
  reload-equals-live rule stated where both sides are produced. No such check exists today.
- **Generated property `web.present-is-pure`**: `present` gives equal views for equal snapshots however they were
  reached, and never mutates its input.
- **Browser flows** (Playwright against `term2-web` with the loopback model double from `serve.integration`):
  first send creates the chat; streaming turn with a tool call; reload mid-turn and after; approval; failed turn
  shows the provider message before and after reload; steer a running turn. Each flow asserts the transcript
  before a reload and again after it.
- **Web typecheck** in the `quality` lane.

## Phases

| Phase | Change | Exit check |
| --- | --- | --- |
| 0 | Web typecheck in CI; delete the dead v1 view path and its example test; first two browser flows. Six other `node:test` files under `web-client/lib/` test live BFF code and are run by nothing: wire them into a lane or delete them, owner's call | CI red on a seeded type error and on a seeded transcript regression |
| 1 | Batched native SSE format; browser-safe fold bundle; `wire.snapshot-is-fold` | property green at 1,000 runs; gateway integration test reads the new format |
| 2 | `session-store` + `present` behind the existing hook interface; remove the old reducers; snapshot gains per-turn reasoning and usage | the 24-cut probe shows 0 differences; all six flows green; delta profile no worse than #425 |
| 3 | Shell policy: move "only the user opens the panel", "chat is created on first send", folder selection and the send gate out of effects into one reducer | each rule is one named transition; the six `C`-class fixes have a flow |

Phase 2 touches the stream consumer for every web session and is high risk under the verification skill: it gets an
independent verifier.

## Assumptions

- Reasoning summaries and per-turn usage should survive a reload (today they do only until the next turn starts).
- The external consumer keeps using v2 unchanged; nothing here removes or alters that encoder.
- Subagent cards are presented from `tasks` and `branches` after phase 2; the `subagent_*` change vocabulary is not
  reproduced in the browser.
