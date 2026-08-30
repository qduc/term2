---
name: architecture
description: Module-design judgement for this codebase — when to extract a module vs keep code local, where policy belongs, and how a turn actually flows from user input to rendered response. Use when adding a service/manager/coordinator, refactoring session or conversation flow, deciding where new policy code belongs, or tracing how a request reaches the model.
---

# Architecture

Prefer deep, cohesive modules over both god objects and over-extracted "ravioli" code. A good module hides meaningful workflow, policy, or state invariants behind a small interface; a bad extraction only renames a step and forces callers to keep knowing the sequence.

## The deletion test

Before extracting, ask what deleting the new module would cost:

- If deleting it would only inline one or two pass-through calls, keep the code local.
- If deleting it would spread policy or invariants across callers, the module is earning its keep.

## Where things belong

Keep orchestration where the domain lifecycle is owned. `TurnWorkflow` may be internally complex as long as it keeps the turn lifecycle local and testable through its public methods.

Keep policy in the policy modules:

| Concern | Owner |
| --- | --- |
| Approval decisions | `services/approval/` |
| Retry classification, recovery decisions | `services/retry/` |
| Provider transport details | `providers/` or `lib/` |

Do not add a new `Runner`, `Driver`, `Coordinator`, `Manager`, or `Handler` just to shorten a file. Add a module only when it owns a stable concept, hides real decisions, or has more than one meaningful caller.

Do not collapse unrelated policy, transport, persistence, and UI behavior into one class. If a module needs "and" to describe unrelated responsibilities, split by ownership, not by line count.

## Entry points

When changing behavior, enter through the public boundary for that feature and follow dependencies inward. Avoid starting from low-level helpers unless the bug is already isolated there. Tests are colocated with production files and are usually the fastest way to discover the intended contract.

Tests should target the owning interface. Avoid tests that require knowing every internal helper unless the helper is itself the owner of a policy or invariant.

## Tracing a turn

For the full path from user input through provider streaming, tool approval, and back to the rendered message, read `reference/runtime-path.md` in this skill directory. Read it when debugging where in the lifecycle something breaks, not as routine background.

## Known constraints

These are not derivable from reading the code:

- `subagent-manager.ts` is a **compatibility facade**. It emits top-level lifecycle events and delegates through the composition root in `runtime.ts`. Do not add execution, prompt, cache, or tool-policy logic back to it. Strategy-specific execution belongs in `mentor-runner.ts` (persistent mentor history, provider continuity), `execution-runner.ts` (one-shot explorer/worker/librarian), or `nested-runner.ts` (cached `Agent.asTool()` instances, approval interruption/resume).
- Role frontmatter, prompt selection, environment context, and tool guidance belong in `role-loader.ts`. Capability construction and write/shell safety policy belong in `tool-policy.ts`. Wiring and the nested role-tool cache stay in `runtime.ts`.
- New providers must be registered through the provider registry.
- New tools must be registered in `agent.ts`.
- `services/session/session-composition.ts` is the single composition root for the session path (moved out of `services/conversation/` in a refactor).
