# UI / Business Layer Separation

## Destination

Term2's interactive and non-interactive surfaces render state and translate user
input, while reusable conversation, approval, settings, provider, handoff, rewind,
and shell policy lives behind application-owned interfaces with focused behavioral
tests. The migration preserves current behavior and lands as reviewable, independently
revertible milestones.

## Notes

- Execution is explicitly authorized by the user; this map remains live through implementation.
- `source/services/session/session-composition.ts` remains the session composition root.
- Approval policy stays in `source/services/approval/`; retry policy stays in `source/services/retry/`.
- UI retains Ink rendering, focus, keyboard ownership, menu stack/bindings, scrolling, terminal effects, and composer restoration.
- Read `docs/plans/menu-system-redesign.md` before changing input/menu files, `docs/plans/queue-editing.md` before changing submission projection, and `docs/plans/mid-turn-injection.md` before changing turn injection.
- Each milestone uses an isolated worktree, TDD at its public seam, focused tests during development, and broader gates proportional to scope.
- Non-interactive, provider, bridge, registry, or run-loop changes additionally run `pnpm test:provider-black-box`.

## Decided

- **Migration shape** — Use vertical behavioral slices; do not create a universal UI controller or move presentation state into services.
- **Integration order** — Land low-overlap policy boundaries first, then workflow owners, then reassess the conversation projection seam.
- **Conversation orchestrator role** — Treat `ConversationOrchestrator` as the current application-to-UI projection layer; thin it last instead of moving it wholesale into the business layer.
- **Non-interactive approval policy** — Merged at `c9312f50`; the CLI now delegates RED/YELLOW/model-advisory decisions to `services/approval` while retaining I/O and continuation looping.
- **Sandbox approval coordination** — Merged at `eae1f4b7`; FIFO, request identity, and fail-closed disposal live outside React, with a fresh coordinator per effect lifetime for StrictMode safety.
- **Pending interaction authority** — Merged at `a8463d3c`; session-owned snapshots and interaction IDs own approval and `ask_user` progression, while React keeps only composer-entry state.
- **Shell interaction ownership** — Merged at `d07a1149`; a non-React shell session owns eligibility, execution history, and deferred flush after in-flight commands.
- **Rewind target ownership** — Merged at `00dd5292`; the conversation store issues opaque snapshot-scoped targets and accepts or rejects rewinds atomically, while Ink retains only post-success projection trimming and visible numbering.
- **Submission authority** — No new extraction is warranted. The run loop already owns pending steers, `QueueController` owns queued state, `ConversationAdapter` owns ID routing and executable payloads, and the orchestrator/Ink state are projections. Add a read-only snapshot only if a second non-Ink surface later needs in-flight submission display.
- **Conversation projection** — Do not add a second immutable event or snapshot bus. `ConversationEvent` already serves reusable/non-interactive consumers; `ConversationOrchestrator` is intentionally the Ink projection adapter and should remain so after its remaining policy owners move out.
- **Conversation admission** — Merged at `9a31f23b`; a non-React workflow owns surge/large-input ordering, confirmation identity, history timing, and the only UI-accessible surge bypass, while Ink retains live preview and composer/attachment effects.

## Open

- **Settings transaction** [research] — Define atomic apply/reset results and runtime side effects after menu Phase 5 removes the remaining direct `InputBox` mutation path.
- **Handoff effects** [research] — Separate the handoff state machine from MenuController timing while preserving correlated intent ordering.
- **Provider and model sessions** [research] — Move persistence, validation, credentials, catalog caching, and traversal policy while retaining list selection and scrolling in Ink.
- **Application commands** [research] — Identify semantic command outcomes that can serve Ink and future surfaces without a generic command manager.

## Fog

- Which compatibility wrappers can be deleted only after all current callers migrate.
- Whether shell interaction and rewind should share the conversation application facade or remain focused sibling services.

## Out of scope

- Visual redesigns, new commands, provider behavior changes, persisted-format changes, or prompt changes.
- Moving menu bindings, keyboard routing, terminal rendering, focus, scrolling, or redraw state into services.
- Adding pass-through Manager, Coordinator, Handler, or universal view-model layers.

## Found in the territory

- 2026-08-08: Active worktrees already overlap `InputBox`, `app.tsx`, `use-conversation`, `ConversationOrchestrator`, conversation events, and provider black-box infrastructure. Settings, handoff, submission, and projection milestones must wait for ownership resolution or merge from those worktrees; non-interactive approval policy is currently isolated.
- 2026-08-08: Review found eager history export and then swallowed export failures in the non-interactive extraction. Lazy acquisition now occurs only on the configured-YELLOW path and remains outside evaluator error normalization.
- 2026-08-08: Review found StrictMode effect replay could permanently dispose the sandbox coordinator. Coordinator lifetime is now per registration effect, while real unmount still denies active and queued requests.
- 2026-08-08: Review found a delayed approval A could resolve approval B. Semantic UI decisions now carry the rendered interaction ID; mismatches are ignored without mutating the current interaction.
- 2026-08-08: Review found closing Shell during slow commands stranded their output outside model context. Close now defers one complete flush until every accepted execution settles.
- 2026-08-08: Review found the rewind migration had dropped foreground abort and introduced command-to-hook type coupling. Abort now occurs only after the domain accepts a target, and the shared selection DTO lives outside React.
- 2026-08-08: Review found capped UI history made store-global rewind ordinals disagree with slash-command ranges and picker labels. Both command selection and rendering now use visible 1-based positions while execution keeps the opaque domain target.
- 2026-08-08: Submission lifecycle research found the planned boundary already exists and `queue-editing.md` had stale completion text. A new tracker would mirror the run loop, queue controller, and adapter rather than deepen their interfaces.
- 2026-08-08: Projection research found a new shared UI event model would duplicate the existing `ConversationEvent` stream, pending-interaction snapshots, and streaming finalization rules without a second interactive renderer to justify it.
- 2026-08-08: Admission review caught an accidental surge-to-large double-confirmation, an unreachable decline restoration path, and completion timing that would leave composer state visible for an entire streamed turn. The workflow now returns synchronous semantic admission plus a completion promise, preserving immediate UI effects and caller awaiting.
- 2026-08-08: Admission review also found the raw surge-bypass option still escaped through `useConversation.sendUserMessage`. The full transport sender is now closure-private and compile-time coverage pins the narrowed public API.
