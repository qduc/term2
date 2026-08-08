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

## Open

- **Pending interaction authority** [research] — Define the smallest session-owned contract that removes approval and `ask_user` protocol authority from React without moving focus or text editing.
- **Submission authority** [research] — Unify guard confirmation, pending steer, queued, admitted, edited, and removed stages without duplicating the queue controller.
- **Settings transaction** [research] — Define atomic apply/reset results and runtime side effects after menu Phase 5 removes the remaining direct `InputBox` mutation path.
- **Handoff effects** [research] — Separate the handoff state machine from MenuController timing while preserving correlated intent ordering.
- **Provider and model sessions** [research] — Move persistence, validation, credentials, catalog caching, and traversal policy while retaining list selection and scrolling in Ink.
- **Application commands** [research] — Identify semantic command outcomes that can serve Ink and future surfaces without a generic command manager.

## Fog

- Whether the final conversation projection should publish immutable events, snapshots, or both.
- Which compatibility wrappers can be deleted only after all current callers migrate.
- Whether shell interaction and rewind should share the conversation application facade or remain focused sibling services.

## Out of scope

- Visual redesigns, new commands, provider behavior changes, persisted-format changes, or prompt changes.
- Moving menu bindings, keyboard routing, terminal rendering, focus, scrolling, or redraw state into services.
- Adding pass-through Manager, Coordinator, Handler, or universal view-model layers.

## Found in the territory

- 2026-08-08: Active worktrees already overlap `InputBox`, `app.tsx`, `use-conversation`, `ConversationOrchestrator`, conversation events, and provider black-box infrastructure. Settings, handoff, submission, and projection milestones must wait for ownership resolution or merge from those worktrees; non-interactive approval policy is currently isolated.
