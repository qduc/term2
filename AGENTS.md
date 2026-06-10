# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

## Project Structure

- **Entry Points**: `cli.tsx` (CLI entry), `app.tsx` (main React component), `non-interactive.ts` (non-interactive mode)
- **Agent Config**: `agent.ts` — Agent definition, tool registration (add new tools here)
- **Agent Client**: `source/lib/agent-client.ts` — Agent client with tool interceptor pattern
- **Agent Factory**: `source/lib/agent-factory.ts` — Agent construction and wiring
- **Slash Commands**: `source/commands/` — Individual slash command implementations (add new commands here); routing via `source/hooks/use-slash-commands.ts` and `source/hooks/use-app-commands.ts`
- **Hooks** (`source/hooks/`): React hooks for UI state — conversation flow (`use-conversation.ts`), slash commands (`use-slash-commands.ts`), input history (`use-input-history.ts`), settings (`use-runtime-settings.ts`), model selection (`use-model-selection.ts`), undo (`use-undo-selection.ts`), trigger detection (`use-trigger-detection.ts`)
- **Services** (`source/services/`): Business logic — `conversation-session.ts` is a thin shell that holds session identity (`id`, `startedAt`) and delegates all turn execution to collaborators assembled by `conversation-session-composition.ts`. Key collaborators: `turn-coordinator.ts` (owns the run/continueAfterApproval loop), `session-stream-processor.ts` (processes agent stream events), `session-retry-orchestrator.ts` (retry classification and state), `session-input-planner.ts` (builds agent input per turn), `session-lifecycle.ts` (per-turn mutable state), `conversation-adapter.ts` (legacy sendMessage/handleApprovalDecision surface, wires directly to `TurnCoordinator`), `session-runtime-controller.ts` (runtime model/provider settings), `session-manager.ts` (state/persistence/undo/snapshot operations), `shell-auto-approval-resolver.ts` (auto-approval decisions), `conversation-store.ts` (in-memory conversation history), `conversation-logger.ts` (turn logging), `approval-flow-coordinator.ts` / `approval-state.ts` (tool approval flow), `session-tool-tracker.ts` (tool execution ledger), `settings-service.ts`, `logging-service.ts`, SSH (`ssh-service.ts`, `execution-context.ts`), plan mode (`plan-mode-interceptor.ts`), large-input guard (`large-uncached-input-guard.ts`), subagents (`subagents/`)
- **Providers** (`source/providers/`): Pluggable provider registry — OpenAI, Anthropic, OpenRouter, OpenAI-compatible, Google, Codex, Llama.cpp, OpenCode. Subdirs: `common/`, `fetch/`, `web-search/`. Add new providers here and register in `registry.ts`.
- **Tools** (`source/tools/`): Tool implementations — shell, search-replace, apply-patch, grep, find-files, read-file, create-file, web-search, web-fetch, code-context, ask-mentor, ask-user, run-subagent, edit-healing. Subdir: `languages/`. Add new tools here and register in `agent.ts`.
- **Prompts** (`source/prompts/`): System prompts for model types and subagents. Subdirs: `fragments/`, `subagents/`. Modify agent behavior here.
- **Components** (`source/components/`): React Ink terminal UI — InputBox, MessageList, ChatMessage, DiffView, StatusBar, ApprovalPrompt, SlashCommandMenu, ModelSelectionMenu, SettingsSelectionMenu, etc. Change the UI here.
- **Utils** (`source/utils/`): Utilities — command safety (`command-safety/`), diff generation, output trimming, token usage, streaming, clipboard, logging, etc.
- **Types** (`source/types/`): TypeScript type definitions
- **Context** (`source/context/`): React context providers
- **Contracts** (`source/contracts/`): Shared interfaces (e.g. `conversation.ts`)
- **Lib** (`source/lib/`): Core agent infrastructure — `agent-client.ts`, `agent-factory.ts`, `retry-executor.ts`, `tool-invoke.ts`, `tool-selection-policy.ts`, `openai-strict-tool-schema.ts`, `editor-impl.ts`, `chained-input-filter.ts`

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` hook calls `conversationService.sendMessage()`
3. `ConversationService` (thin facade) delegates to `ConversationSession`, which is itself a thin shell — it holds session identity (`id`, `startedAt`) and forwards `run()` / `continueAfterApproval()` calls to `TurnCoordinator` via the composition
4. `TurnCoordinator` orchestrates each turn: it calls `SessionInputPlanner` to build the agent input, drives the agent via `source/lib/agent-client.ts`, and feeds the stream to `SessionStreamProcessor`
5. `ConversationAdapter` provides the legacy `sendMessage`/`handleApprovalDecision` surface and wires directly to `TurnCoordinator` (no round-trip through `ConversationSession`)
6. The agent client selects a provider through the Provider Registry and streams the response
7. Tool requests are validated by `ApprovalFlowCoordinator` and paused for user approval before execution (auto-approved in standard mode for patches)
8. User approves/rejects via `ApprovalPrompt` component; `continueAfterApproval()` resumes the turn via `TurnCoordinator`
9. `SessionRetryOrchestrator` classifies errors and emits retry events; `TurnCoordinator` re-drives the turn on retry
10. Final response appears in the message list

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.
After making code changes, you MUST run tests appropriate to the scope of the task and report the results.

- For small, localized changes: run focused tests for the affected area.
- For broad changes, architectural changes, shared utilities, or changes that may affect multiple areas: run the full test suite.
- If no relevant focused test exists, run the smallest applicable broader test command and explain why.

```bash
npm test              # Run all tests
npm run test:verbose -- <source/*.test.ts>           # Run a single .ts source test
npm run test:verbose -- dist/<path to compiled JS test file>  # Use for .tsx tests; dist paths omit the leading source/
npx prettier --write <file1, file2, file3> # Fix formatting issues in files you changed
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
