---
name: architecture
description: Module-design judgement for this codebase — when to extract a module vs keep code local, which layer owns new code, where policy belongs, and which of the two turn paths a change touches. Use when adding a module, refactoring session, engine or delegation flow, deciding where new policy code belongs, responding to an architecture gate failure, or tracing how a request reaches the model.
---

# Architecture

Prefer deep, cohesive modules over both god objects and over-extracted "ravioli" code. A good module hides meaningful workflow, policy, or state invariants behind a small interface; a bad extraction only renames a step and forces callers to keep knowing the sequence.

## The deletion test

Before extracting, ask what deleting the new module would cost:

- If deleting it would only inline one or two pass-through calls, keep the code local.
- If deleting it would spread policy or invariants across callers, the module is earning its keep.

Do not add a new `Runner`, `Driver`, `Coordinator`, `Manager`, or `Handler` just to shorten a file. Add a module only when it owns a stable concept, hides real decisions, or has more than one meaningful caller. Splitting one idea into a `*-policy`, `*-capability` and `*-registry` trio is the same mistake spread over three files.

Do not collapse unrelated policy, transport, persistence, and UI behavior into one class. If a module needs "and" to describe unrelated responsibilities, split by ownership, not by line count.

## Which layer owns it

`src/` is one folder per layer, and dependencies point down. [`docs/architecture/layers.md`](../../../docs/architecture/layers.md) has the layer table, the import rules and the rules that make this tree different from the old engine: one append-only log replayed into every view, one projection of wire events in `protocol/`, an engine that waits for answers instead of calling up, and names that say the job. Decide the layer before the file name. When the layer that owns a concept cannot import what it needs, that is a design question: have `app/` inject a port, or move the code. Do not reach upward.

Policy keeps one owner:

| Concern | Owner |
| --- | --- |
| Approval decisions | `src/session/approval/` |
| Retry classification, recovery decisions | `src/engine/retry/` |
| Provider transport details | `src/model/providers/` |
| Child-agent roles, pools, capability and safety policy | `src/delegation/` (see its `README.md`) |
| Wiring concrete layers together | `src/app/` (`application.ts` is the composition root) |

## Gates

The layer rules, file size, names, reachability and the exception lists are checked on every commit (`layers.md`, "Rule checks"). A failure prints why the rule exists and what does not count as a fix. Fix the violation, or record a deviation with a reason a reviewer can judge, as [When a gate fails](../../../docs/architecture/layers.md#when-a-gate-fails) describes. `node scripts/gate-exceptions.mjs <rule>` shows the precedent. Changing code only to satisfy a gate's number is not a fix, and the deletion test above still applies to a split the line limit prompted.

## Two turn paths

A change usually touches one of two paths, and they share less than their names suggest. Find out which one before editing. [`docs/architecture/architecture-overview.md`](../../../docs/architecture/architecture-overview.md) maps both.

- **The foreground turn.** Every client (TUI, headless, ACP, control socket, Discord) attaches to the in-process host, and a turn runs through `protocol/commands.ts`, the live session (`session/session.ts`, `session/conversation.ts`), `session/conversation-turn.ts` and `engine/turn.ts`. `conversation-turn.ts` appends each turn event's facts to the log before the turn advances, and every view is replayed from that log (`session/replay.ts`). "How a message travels" in `layers.md` is the path.
- **The delegation runtime.** The legacy subagent path (`delegation/subagents/subagent-manager.ts` and its runners) still drives `ApplicationRunLoop` in `engine/agent-runtime/`. `execution-runner.ts` wraps it in a session runtime built by `createSessionRuntime` (`session/session/`), where `ConversationRecord` owns acceptance; the mentor and nested runners construct the loop directly. [`conversation-core.md`](../../../docs/architecture/conversation-core.md) and [`conversation-loop.md`](../../../docs/architecture/conversation-loop.md) describe that runtime.

In the delegation runtime, keep execution advancement in `ApplicationRunLoop.#runTurn`. `SessionTurnAdapter` supplies bounded preparation, synchronous acceptance callbacks, event projection, decisions and recovery policy; it must not start continuation streams or add another turn-driving loop. `ConversationRecord` owns acceptance of provider history, tool evidence and assistant journal items, and runtime acceptance precedes event publication. None of this applies to `engine/turn.ts`.

A policy that exists on both paths is a drift risk: fixing it on one path leaves the other behind. Search for the same behavior on the other path before changing it on one.

## Entry points

When changing behavior, enter through the public boundary for that feature and follow dependencies inward. Each layer's `index.ts` and its `README.md`, where it has one, name that boundary. Avoid starting from low-level helpers unless the bug is already isolated there.

Permanent unit tests are not allowed during the evidence-driven development experiment, so `tests/` holds integration, e2e, provider black-box and guard tests, laid out by layer. They exercise public boundaries and are a good map of the intended contract. Use the `verification` and `testing` skills to decide how to prove a change.

## Tracing a turn

For where in the lifecycle something breaks, read `reference/runtime-path.md` in this skill directory. Read it when debugging, not as routine background.

## Known constraints

These are not derivable from reading the code:

- `subagent-manager.ts` is a **compatibility facade**. It emits top-level lifecycle events and delegates through the composition root in `delegation/subagents/runtime.ts`. Do not add execution, prompt, cache, or tool-policy logic back to it. Strategy-specific execution belongs in `mentor-runner.ts` (persistent mentor history, provider continuity), `execution-runner.ts` (one-shot explorer/worker/librarian, inside a session runtime), or `nested-runner.ts` (cached `Agent.asTool()` instances, approval interruption/resume).
- Role frontmatter, prompt selection, environment context, and tool guidance belong in `role-loader.ts`. Capability construction and write/shell safety policy belong in `tool-policy.ts`. Wiring and the nested role-tool cache stay in `runtime.ts`. All three live in `src/delegation/subagents/`.
- The native child-agent launcher is separate from that legacy path: `src/delegation/direct/` runs children through session-owned branch and task ports.
- New providers must be registered through the provider registry (`src/model/providers/index.ts`).
- New tools are defined in `src/app/agent.ts`; the tool surface (`src/app/tool-surface.ts`, through `app/lib/agent-factory.ts`) builds them from there.
- `src/session/session/session-composition.ts` composes the delegation runtime's session, not the foreground session.
