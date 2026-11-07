# Architecture Overview

Terminal AI assistant: React (Ink) UI, an application-owned agent runtime and
TypeScript/Node. It chats with an agent that can run shell commands and edit files,
gated by approval prompts. Clients (TUI, headless, ACP, control socket, Discord) render
one wire protocol from one host.

Start with [`layers.md`](layers.md). It is the reference for the source layers, their
import rules, how a message travels and the rule checks that enforce all of it. This
page only answers the question `layers.md` leaves open: **which turn path does a change
touch?** There are two, and they share less than their names suggest.

## The foreground turn

Every conversation a person has with term2 runs here.

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

## The delegation runtime

The legacy subagent path still runs on the pre-rewrite engine, `ApplicationRunLoop`
(`engine/agent-runtime/`). `delegation/subagents/subagent-manager.ts` is its facade;
the run logic lives in three runners:

| Runner | How it drives the loop |
| --- | --- |
| `execution-runner.ts` (one-shot explorer/worker/librarian) | Inside a session runtime from `createSessionRuntime` (`session/core/session-runtime.ts`, composed in `session/session/session-composition.ts`). `ConversationRecord` owns acceptance there. |
| `mentor-runner.ts`, `nested-runner.ts` | Construct the loop directly through `engine/agent-runtime/legacy-nested-driver.ts`, wired by `delegation/runtime/compose-agent-runtime.ts`. |

[`conversation-core.md`](conversation-core.md) and
[`conversation-loop.md`](conversation-loop.md) describe this runtime: the model–tool
loop, acceptance into `ConversationRecord`, and the contracts for approval, retry,
cancellation and persistence. None of it applies to `engine/turn.ts`.

The native child-agent launcher in `delegation/direct/` is separate from this path; it
uses session-owned branch and task ports. See [`src/delegation/README.md`](../../src/delegation/README.md).

## When a behavior exists on both paths

Some policies exist once per path. For example, the `[Conversation timing]` notice for
a gap between human messages is built by `session/time-gap.ts` on the foreground path
and by `shared/conversation/conversation-time-gap.ts` in the delegation runtime. The
two handle invalid timestamps differently. Before changing such a behavior, find its
twin, and say in the change which path you changed and why the other may differ.

## Where to go next

- [`layers.md`](layers.md) — layers, import rules, message path, rule checks, and what
  to do when a gate fails.
- Each layer's `index.ts` and `README.md` — that layer's public boundary.
- The `architecture` skill (`.agents/skills/architecture/`) — module-design judgement
  and the runtime-path reference for debugging.
- [`assistant-output-recovery-architecture.md`](assistant-output-recovery-architecture.md)
  — recovery of assistant output.

The pre-rewrite overview, with `ConversationOrchestrator`, `ConversationService`,
`ConversationAdapter`, `TurnCoordinator` and `TurnWorkflow` on the main path, and its
internals pages (`turn-workflow-internals.md`, `conversation-orchestrator-internals.md`)
described the `source/` tree deleted at the flip (#86–#88). Git history keeps them, for
example at commit `5839510`.
