# Architecture Overview

Terminal AI assistant: React (Ink) UI, an application-owned agent runtime and
TypeScript/Node. It chats with an agent that can run shell commands and edit files,
gated by approval prompts. Clients (TUI, headless, ACP, control socket, Discord) render
one wire protocol from one host.

Start with [`layers.md`](layers.md). It is the reference for the source layers, their
import rules, how a message travels and the rule checks that enforce all of it. This
page answers the question `layers.md` leaves open: **which code actually runs a turn?**
One path does. A second, pre-rewrite engine is still in `src/` but never runs, and it is
easy to mistake for live code.

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

## Legacy code that never runs

The pre-rewrite subagent engine is still in `src/`, but production never executes it.
Nothing constructs its entry points, every production import of them is `import type`,
and the built bundle (`dist/src/app/cli.bundle.cjs`) contains none of its classes:

| Dead | Where |
| --- | --- |
| `SubagentManager` and its runners (`execution-runner.ts`, `mentor-runner.ts`, `nested-runner.ts`) | `delegation/subagents/` |
| `SubagentBridge`, `compose-agent-runtime.ts` | `delegation/runtime/` |
| `AgentConfiguration` | `app/lib/agent-configuration.ts` |
| `ApplicationRunLoop` and most of the loop machinery | `engine/agent-runtime/` |
| `createSessionRuntime`, `SessionTurnAdapter`, `TurnCoordinator` and nearly everything else | `session/session/` |
| `ConversationRecord` | `session/conversation/` |

The reachability gate counts type-only imports, so it reports this code as reached
(#196). Deleting it is #197. Until then:

- Do not fix bugs or add behavior there; a change there reaches no user.
- Some files beside it are live: the role, tool-policy, pool and worktree policy that
  `delegation/direct/` uses (`delegation/subagents/role-loader.ts`, `tool-policy.ts`,
  `subagent-role-pool-selector.ts`, `worker-worktree.ts`), and the resolvers, budgets
  and `generation-guard.ts` in `engine/agent-runtime/`. Before relying on anything in
  these folders, search the built bundle for it.
- [`conversation-core.md`](conversation-core.md) and [`conversation-loop.md`](conversation-loop.md)
  describe the dead runtime. They are worth reading only for its design rationale.

A behavior that exists in both places is a trap: a fix to the dead copy changes nothing.
For example, the `[Conversation timing]` notice's clock and notice rules live once in
`shared/conversation/conversation-time-gap.ts`. The live path uses them through
`session/time-gap.ts`; the history helpers in the same shared file serve only the dead
runtime and go with it.

## Where to go next

- [`layers.md`](layers.md) — layers, import rules, message path, rule checks, and what
  to do when a gate fails.
- Each layer's `index.ts` and `README.md` — that layer's public boundary.
- The `architecture` skill (`.agents/skills/architecture/`) — module-design judgement
  and the runtime-path reference for debugging.
- [`assistant-output-recovery-architecture.md`](assistant-output-recovery-architecture.md)
  — recovery of assistant output.

The earlier overview, with `ConversationOrchestrator`, `ConversationService`,
`ConversationAdapter`, `TurnCoordinator` and `TurnWorkflow` on the main path, and its
internals pages (`turn-workflow-internals.md`, `conversation-orchestrator-internals.md`)
described the `source/` tree deleted at the flip (#86–#88). Git history keeps them, for
example at commit `5839510`.
