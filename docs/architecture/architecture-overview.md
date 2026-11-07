# Architecture Overview

Terminal AI assistant: React (Ink) UI, an application-owned agent runtime and
TypeScript/Node. It chats with an agent that can run shell commands and edit files,
gated by approval prompts. Clients (TUI, headless, ACP, control socket, Discord) render
one wire protocol from one host.

Start with [`layers.md`](layers.md). It is the reference for the source layers, their
import rules, how a message travels and the rule checks that enforce all of it. This
page answers the question `layers.md` leaves open: **which code actually runs a turn?**
One path does. The unused pre-rewrite runtime was removed in #197.

## The turn path

Every conversation, every client and every child agent runs here.

```
client ── WireCommand ──▶ host/in-process-direct.ts ──▶ protocol/commands.ts
                                                            │
                                         session/session.ts │ (live DirectSession)
                                    session/conversation.ts │ appends admission facts
                               session/conversation-turn.ts │ appends each event's facts, then accepts it
                                             engine/turn.ts ▼ waits for answers; never calls up
                                   engine/turn-model.ts ──▶ app model registry ──▶ model/provider.ts
```

- **One log.** The session appends native facts (`session/facts.ts`) to one JSONL log.
  History, status, the pending interaction, the queue and retry eligibility are replayed
  from it (`session/replay.ts`).
- **One projection.** `protocol/projection.ts` turns session updates into `WireEvent`s
  once per session; every attached client reads the same events.
- **The engine waits.** An approval or question is an `interaction_required` event; the
  turn waits in memory and the session alone writes the pending interaction.

Details: "How a message travels" and "Where an approval waits" in `layers.md`.
`bench/hops.mts` measures this path, so its output is the current file list.

Child agents run on the same path: `delegation/direct/` (`createDirectSubagentTools`)
launches each one as a session branch (`session/branches.ts`) that runs through
`startNestedTurn` in `engine/turn.ts`. See [`src/delegation/README.md`](../../src/delegation/README.md).

## Retained shared policy

The direct launcher uses the role loader, tool policy, role-pool selector and worker
worktree helpers in `delegation/subagents/`. These are policy, not a second runner.
`engine/agent-runtime/` retains live resolvers, budgets and its generation guard;
workflow launch contracts remain type-only. Compatibility role-definition adaptation
and offline v3 migration remain supported. The public `./hooks` entrypoint retains
its type contract.

The archived [conversation core](conversation-core.md), [conversation loop](conversation-loop.md)
and [output recovery](assistant-output-recovery-architecture.md) documents describe
only the removed runtime. They are not implementation guidance for the live path.

## Where to go next

- [`layers.md`](layers.md) — layers, import rules, message path, rule checks, and what
  to do when a gate fails.
- Each layer's `index.ts` and `README.md` — that layer's public boundary.
- The `architecture` skill (`.agents/skills/architecture/`) — module-design judgement
  and the runtime-path reference for debugging.
- [`assistant-output-recovery-architecture.md`](assistant-output-recovery-architecture.md)
  — archived recovery design for the removed runtime.

The earlier overview, with `ConversationOrchestrator`, `ConversationService`,
`ConversationAdapter`, `TurnCoordinator` and `TurnWorkflow` on the main path, and its
internals pages (`turn-workflow-internals.md`, `conversation-orchestrator-internals.md`)
described the `source/` tree deleted at the flip (#86–#88). Git history keeps them, for
example at commit `5839510`.
