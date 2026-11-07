# Runtime path: user input to rendered response

Useful when locating *where* a failure occurs; not needed for routine feature work.

**Foreground turn.** Follow "How a message travels" and "Where an approval waits" in
`docs/architecture/layers.md`: client, in-process host, `protocol/commands.ts`, the live
session, `session/conversation-turn.ts`, `engine/turn.ts`, the model registry and the
provider. Read those two sections, then the layer's `index.ts`. `bench/hops.mts`
measures this path, so its output is the current file list.

**Delegation runtime.** `src/engine/agent-runtime/` (`ApplicationRunLoop`) is the loop
the legacy subagent runners in `src/delegation/subagents/` drive: `execution-runner.ts`
through a session runtime (`createSessionRuntime`, `src/session/session/`), and the
mentor and nested runners directly through `legacy-nested-driver.ts`. Start at
`#runTurn`, then `docs/architecture/conversation-loop.md`. The native launcher policy
lives in `src/delegation/direct/` and uses session-owned branch/task ports.

The legacy path this file once described (`app.tsx`, `ConversationOrchestrator`,
`ConversationService`, `ConversationAdapter`, `QueueController`, `TurnWorkflow`) was
deleted at the flip (#88); git history keeps it.
