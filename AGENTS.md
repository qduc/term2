# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

## Project Structure

Most application code lives under `source/`. Navigate by responsibility rather than by filename:

- **Start with the runtime path**: `cli.tsx` assembles the application, `app.tsx` owns the interactive Ink UI, and `non-interactive.ts` runs the same conversation system without the UI. `agent.ts` defines the agent and registers its tools.
- **UI and user interaction**: `source/components/` contains presentational Ink components. `source/hooks/` owns interactive state and behavior such as conversation handling, input modes, menus, settings, and keyboard actions. `source/commands/` implements slash commands.
- **Conversation and turn execution**: `source/services/conversation/` owns the public conversation facade, event contracts, history, and persistence. `source/services/session/` owns the lifecycle of a foreground turn, including initial execution, approval continuation, streaming, retries, and session state. `session-composition.ts` is the single composition root; begin with `conversation-service.ts`, then `session-composition.ts` and `turn-coordinator.ts`.
- **Approval and recovery policy**: `source/services/approval/` decides when and how tools require approval. `source/services/retry/` classifies failures and decides whether execution should resume, retry, or restart. Keep policy decisions in these directories rather than in UI or provider code.
- **Providers and model transport**: `source/providers/` contains provider registration, provider-specific adapters, response normalization, and transport middleware. Shared agent-client infrastructure and tool interception live in `source/lib/`. New providers must be registered through the provider registry.
- **Subagent execution**: `source/services/subagents/subagent-manager.ts` is a compatibility facade that emits top-level lifecycle events and delegates through the composition root in `runtime.ts`. Strategy-specific execution belongs in `mentor-runner.ts` for persistent mentor history and provider continuity, `execution-runner.ts` for one-shot explorer/worker/researcher sessions, and `nested-runner.ts` for cached `Agent.asTool()` instances, approval interruption/resume, and nested bookkeeping. Role frontmatter, prompt selection, environment context, and tool guidance belong in `role-loader.ts`; capability construction and write/shell safety policy belong in `tool-policy.ts`. Keep wiring and the nested role-tool cache in `runtime.ts`, and do not add execution, prompt, cache, or tool-policy logic back to `SubagentManager`.
- **Tools and prompts**: `source/tools/` contains the capabilities exposed to the agent, grouped by domain such as file, system, web, and agent interaction. Register new tools in `agent.ts`. Agent and subagent instructions live in `source/prompts/`.
- **Cross-cutting services**: settings, logging, subagents, notifications, execution context, and provider continuity live under `source/services/` in their named areas. Reusable domain helpers belong in `source/utils/`; shared data shapes belong in `source/types/` or `source/contracts/`.

When changing behavior, enter through the public boundary for that feature and follow dependencies inward. Avoid starting from low-level helpers unless the bug is already isolated there. Tests are colocated with production files and are usually the fastest way to discover the intended contract.

## Architecture Balance

Prefer deep, cohesive modules over both god objects and over-extracted "ravioli" code. A good module should hide meaningful workflow, policy, or state invariants behind a small interface; a bad extraction only renames a step and forces callers to keep knowing the sequence.

When changing session or conversation flow:

- Keep orchestration where the domain lifecycle is owned. `TurnWorkflow` may be internally complex if it keeps the turn lifecycle local and testable through its public methods.
- Keep policy in the policy modules. Approval decisions belong in `services/approval/`; retry classification and recovery decisions belong in `services/retry/`; provider transport details belong in `providers/` or `lib/`.
- Do not add a new `Runner`, `Driver`, `Coordinator`, `Manager`, or `Handler` just to shorten a file. Add a module only when it owns a stable concept, hides real decisions, or has more than one meaningful caller.
- Do not collapse unrelated policy, transport, persistence, and UI behavior into one class. If a module needs "and" to describe unrelated responsibilities, split by ownership, not by line count.
- Before extracting, apply the deletion test: if deleting the new module would only inline one or two pass-through calls, keep the code local; if deleting it would spread policy or invariants across callers, the module is probably earning its keep.
- Tests should target the owning interface. Avoid tests that require knowing every internal helper unless the helper is itself the owner of a policy or invariant.

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` calls `ConversationService.sendMessage()`
3. `ConversationService` delegates terminal execution to the `ConversationAdapter` created by `session-composition.ts`
4. `ConversationAdapter` establishes logging/traffic context, collects terminal events, and calls `TurnCoordinator.start()` directly
5. `TurnCoordinator.start()` guards turn admission with `TurnStatusMachine`, checks stale/aborted approval state through `ApprovalFlowCoordinator`, and delegates execution to `TurnWorkflow.executeInitial()`
6. `TurnWorkflow` prepares input through `InitialInputPreparer` and `SessionInputPlanner`, drives the agent client, feeds events to `SessionStreamProcessor`, and returns a turn outcome
7. The agent client selects a provider through the Provider Registry and streams the response
8. Tool requests are validated by `ApprovalFlowCoordinator` and paused for user approval; `TurnStatusMachine` transitions to `awaiting_approval`
9. Approval/rejection follows the same facade and adapter path, then `ConversationAdapter` calls `TurnCoordinator.continueAfterApproval()` directly
10. `TurnCoordinator` delegates approved continuation execution to `TurnWorkflow.executeContinuation()`, which applies the decision, streams tool/model work, and returns `response`, `approval_required`, `fresh_start_required`, or `stale`
11. Retry logic in `services/retry/` classifies errors and handles recovery; `fresh_start_required` lets `TurnWorkflow` re-drive initial execution from history
12. The terminal result is collected by `ConversationAdapter` and rendered in the message list

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.
After making code changes, you MUST run tests appropriate to the scope of the task and report the results.

- For small, localized changes: run focused tests for the affected area.
- For broad changes, architectural changes, shared utilities, or changes that may affect multiple areas: run the full test suite.
- If no relevant focused test exists, run the smallest applicable broader test command and explain why.

```bash
pnpm test              # Run all tests
pnpm test path/to/my-file.test.ts # Run tests in a specific file
pnpm exec prettier --write <file1, file2, file3> # Fix formatting issues in files you changed
```

### Unit Test Guidelines

- Test observable behavior through public interfaces, not implementation details. A refactor shouldn't break tests.
- One behavior per test; name tests after the rule being verified.
- Keep tests deterministic and independent — no real time, randomness, network, DB, or filesystem. Runnable in any order.
- Mock only at boundaries.
- Assert structured values (codes, statuses, types) over raw strings or broad snapshots, unless the text or full output *is* the contract.
- Don't duplicate production logic in expected values.
- Cover edge cases, boundaries, and invalid input.
- Keep tests fast and setup minimal.
- Add regression tests for bugs.
- Maintain tests like production code: refactor or delete when they stop providing value.

## Log Files

App logs are stored as JSONL files. Log root by platform:
- **Linux**: `~/.local/state/term2-nodejs/logs/`
- **macOS**: `~/Library/Logs/term2-nodejs/logs/`

Traffic logs are stored as JSONL files and can be large. Log root by platform:
- **Linux**: `~/.local/state/term2-nodejs/logs/provider-traffic/`
- **macOS**: `~/Library/Logs/term2-nodejs/logs/provider-traffic/`

When inspecting them, always use `jq` to query only the fields you need rather than reading the whole file. For example:

```bash
jq '.summary.unknownFrames' <file.jsonl>
jq 'select(.direction == "received") | .summary.payload' <file.jsonl>
```

## Shell Safety For Agents

- Never run ad-hoc shell probes that contain command strings with executable payloads such as `rm`, `find -exec`, `sed -i`, redirections, command substitution, backticks, or shell metacharacters. Shell quoting mistakes can turn test fixtures into real commands.
- When testing command parsing or safety classification, put cases in an AVA test file or another quoted fixture file and run the test harness. Do not pass dangerous command examples through `node -e`, `tsx -e`, `sh -c`, command substitution, or inline shell one-liners.
- If you need to inspect classifier behavior interactively, use hardcoded string literals inside a committed/temporary test file and execute only the test runner. Keep dangerous strings as data, never as shell syntax.
- Before running any command that could modify or delete files outside the intended edit set, stop and use a safer read-only inspection path or ask for explicit approval.
