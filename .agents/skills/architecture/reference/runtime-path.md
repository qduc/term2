# Runtime path: user input to rendered response

Useful when locating *where* a failure occurs; not needed for routine feature work.

**Foreground turn.** Follow "How a message travels" and "Where an approval waits" in
`docs/architecture/layers.md`: client, in-process host, `protocol/commands.ts`, the live
session, `session/conversation-turn.ts`, `engine/turn.ts`, the model registry and the
provider. Read those two sections, then the layer's `index.ts`. `bench/hops.mts`
measures this path, so its output is the current file list.

**Child agents.** `src/delegation/direct/` launches them as session branches
(`session/branches.ts`) that run through `startNestedTurn` in the same `engine/turn.ts`.
See `src/delegation/README.md`.

**Removed runtime.** The pre-rewrite run loop, subagent bridge/manager/runners and
session composition were deleted in #197. Retained helpers in those folders are
shared policy, not another execution path. Offline v3 input projection now lives
with its converter in `scripts/conversation-migration/`.

The legacy path this file once described (`app.tsx`, `ConversationOrchestrator`,
`ConversationService`, `ConversationAdapter`, `QueueController`, `TurnWorkflow`) was
deleted at the flip (#88); git history keeps it.
