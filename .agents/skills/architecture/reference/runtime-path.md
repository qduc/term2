# Runtime path: user input to rendered response

Useful when locating *where* a failure occurs; not needed for routine feature work.

The foreground turn follows "How a message travels" and "Where an approval
waits" in `docs/architecture/layers.md`: client, in-process host, `protocol/commands.ts`,
the live session, `engine/turn.ts`, the model registry and the provider. Read
those two sections, then the layer's `index.ts`.

The legacy path this file used to describe (`app.tsx`, `ConversationOrchestrator`,
`ConversationService`, `ConversationAdapter`, `QueueController`) was deleted at
the flip (#88); git history keeps it. `src/engine/agent-runtime/`
(`ApplicationRunLoop`) survives as the loop the mentor and nested subagent
runners in `src/delegation/subagents/` construct directly. The native launcher
policy lives in `src/delegation/direct/` and uses session-owned branch/task ports.
