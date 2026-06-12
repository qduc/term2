# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

## Project Structure

- **Entry Points**: `cli.tsx` (CLI entry), `app.tsx` (main React component), `non-interactive.ts` (non-interactive mode)
- **Agent Config**: `agent.ts` — Agent definition, tool registration (add new tools here)
- **Slash Commands** (`source/commands/`): Individual slash command implementations — `clear-command.ts`, `copy-command.ts`, `effort-command.ts`, `guarded-settings-command.ts`, `handoff-command.ts`, `mode-commands.ts`, `model-command.ts`, `quit-command.ts`, `retry-command.ts`, `undo-command.ts`, `usage-command.ts`, `auto-approve-command.ts`. Add new commands here and route them via `source/slash-commands.ts`.
- **Hooks** (`source/hooks/`): React hooks for UI state — conversation flow (`use-conversation.ts`), slash commands (`use-slash-commands.ts`), app commands (`use-app-commands.ts`), input history (`use-input-history.ts`), settings completion (`use-settings-completion.ts`, `use-settings-value-completion.ts`), runtime settings (`use-runtime-settings.ts`), model selection (`use-model-selection.ts`), provider selection (`use-provider-selection.ts`), undo (`use-undo-selection.ts`), selection (`use-selection.ts`), setting (`use-setting.ts`), escape key (`use-escape-key.ts`), mode handlers (`use-mode-handlers.ts`), shell mode (`use-shell-mode.ts`), trigger detection (`use-trigger-detection.ts`), path completion (`use-path-completion.ts`, `path-completion-filter.ts`), terminal width (`use-terminal-width.ts`), message ID (`message-id.ts`)
- **Services** (`source/services/`): Business logic, organized into subdirectories:
  - `session/` — Turn execution: `conversation-session.ts` (thin shell holding session identity, delegates to `TurnCoordinator` via `session-composition.ts`), `turn-coordinator.ts` (orchestrates `TurnStatusMachine`, `InitialTurnRunner`, `ContinuationDriver`, and `ApprovalFlowCoordinator`), `turn-status-machine.ts` (turn status transitions), `initial-turn-runner.ts` (initial agent run), `continuation-driver.ts` (approval continuation with `DriveResult`), `session-stream-processor.ts` (stream event processing), `session-input-planner.ts` (agent input building), `session-lifecycle.ts` (per-turn mutable state), `session-runtime-controller.ts` (runtime model/provider settings), `session-manager.ts` (state/persistence/undo/snapshot), `session-tool-tracker.ts` (tool execution ledger), `session-factory.ts`, `session-context-service.ts`, `initial-input-preparer.ts`, `initial-stream-cycle.ts`, `continuation-plan-applier.ts`, `continuation-recovery-handler.ts`, `continuation-state.ts`, `continuation-stream-cycle.ts`, `turn-attempt.ts`, `turn-attempt-factory.ts`, `turn-item-accumulator.ts`, `terminal-result-collector.ts`
  - `conversation/` — Conversation state: `conversation-service.ts`, `conversation-adapter.ts`, `conversation-store.ts`, `conversation-store-adapter.ts`, `conversation-persistence.ts`, `conversation-result-builder.ts`, `conversation-turn-items.ts`, `conversation-events.ts`, `conversation-history-repair.ts`
  - `approval/` — Tool approval flow: `approval-flow-coordinator.ts`, `approval-state.ts`, `approval-decision-policy.ts`, `approval-presentation-policy.ts`, `shell-auto-approval-evaluator.ts`, `shell-auto-approval-resolver.ts`, `tool-owner.ts`
  - `retry/` — Error recovery: `recovery-executor.ts`, `recovery-policy.ts`, `retry-classifier.ts`, `retry-contracts.ts`, `retry-error-classification.ts`, `retry-event-presenter.ts`, `conversation-retry-policy.ts`, `upstream-retry-policy.ts`
  - `logging/` — Logging: `logging-service.ts`, `conversation-logger.ts`, `conversation-log-writer.ts`, `conversation-log-events.ts`, `logging-contract.ts`, `provider-traffic.ts`
  - `settings/` — Settings: `settings-service.ts`, `settings-schema.ts`, `settings-sources.ts`, `settings-merger.ts`, `settings-persistence.ts`, `settings-env.ts`
  - `subagents/` — Subagent management: `subagent-manager.ts`, `subagent-session.ts`, `subagent-client-types.ts`, `types.ts`
  - Top-level files: `agent-stream.ts`, `command-message-streaming.ts`, `conversation-agent-client.ts`, `execution-context.ts`, `file-service.ts`, `generation-guard.ts`, `history-service.ts`, `input-surge-guard.ts`, `interruption-info.ts`, `large-uncached-input-guard.ts`, `mode-notices.ts`, `model-service.ts`, `notification-service.ts`, `plan-mode-interceptor.ts`, `provider-continuity.ts`, `rtk-service.ts`, `service-interfaces.ts`, `ssh-service.ts`, `stream-event-parsing.ts`, `stream-event-processor.ts`, `stream-snapshot.ts`, `tool-call-arguments.ts`, `tool-execution-ledger.ts`
- **Lib** (`source/lib/`): Core agent infrastructure — `agent-client.ts` (tool interceptor pattern), `agent-factory.ts` (agent construction/wiring), `agent-chat-service.ts`, `agent-configuration.ts`, `agent-run-orchestrator.ts`, `ask-user-answer-store.ts`, `chained-input-filter.ts`, `editor-impl.ts`, `openai-strict-tool-schema.ts`, `retry-executor.ts`, `runner-manager.ts`, `subagent-bridge.ts`, `tool-interceptor-registry.ts`, `tool-invoke.ts`, `tool-selection-policy.ts`
- **Providers** (`source/providers/`): Pluggable provider registry — `registry.ts` (registration), `provider-service.ts`, `index.ts`. Multi-model providers: `openai.provider.ts`, `anthropic-middleware.ts`, `ai-sdk-anthropic.provider.ts`, `ai-sdk-google.provider.ts`, `ai-sdk-openrouter.provider.ts`, `ai-sdk-agents-adapter.ts`, `ai-sdk-message-normalizer.ts`, `openrouter.provider.ts`, `openrouter.ts`, `openai-compatible.provider.ts`, `openai-compatible-lazy.ts`, `openai-compatible-models.ts`, `openai-compatible-middleware.ts`, `openai-compatible-response-normalizer.ts`, `codex.provider.ts`, `codex-responses-model.ts`, `llama-cpp.provider.ts`, `opencode.provider.ts`, `opencode-routing.ts`, `opencode-session.ts`, `fallback-responses-model.ts`, `retrying-model.ts`. Subdirs: `common/` (shared utilities, errors), `fetch/` (fetch compose/composer, logging middleware), `web-search/` (Exa, Tavily, registry, types). Add new providers here and register in `registry.ts`.
- **Tools** (`source/tools/`): Tool implementations organized by category:
  - `file/` — File operations: `search-replace.ts`, `apply-patch.ts`, `create-file.ts`, `read-file.ts`, `find-files.ts`, `edit-healing.ts`, `file-locks.ts`
  - `system/` — System operations: `shell.ts`, `grep.ts`, `code-context.ts`
  - `web/` — Web operations: `web-search.ts`, `web-fetch.ts`
  - `agent/` — Agent interaction: `ask-user.ts`, `ask-mentor.ts`, `run-subagent.ts`
  - `languages/` — Language-specific edit helpers: `typescript.ts`, `python.ts`, `go.ts`, `rust.ts`, `java.ts`, `cpp.ts`, `csharp.ts`, `php.ts`, `ruby.ts`, `json.ts`, plus `index.ts`, `types.ts`, `utils.ts`
  Add new tools here and register in `agent.ts`.
- **Prompts** (`source/prompts/`): System prompts for model types and subagents. Subdirs: `fragments/`, `subagents/`. Modify agent behavior here.
- **Components** (`source/components/`): React Ink terminal UI, organized into subdirectories:
  - `input/` — `PopupManager.tsx`, `determine-active-menu.ts`, `input-width.ts`, `insertions.ts`, `popup-key-navigation.ts`, `popup-props.ts`, `triggers.ts`
  - `layout/` — `Banner.tsx`, `BottomArea.tsx`, `DiffView.tsx`, `StatusBar.tsx`
  - `message/` — `MessageList.tsx`, `ChatMessage.tsx`, `CommandMessage.tsx`, `SubagentActivityMessage.tsx`, `command-message-helpers.ts`
  - `menu/` — `SlashCommandMenu.tsx`, `ModelSelectionMenu.tsx`, `ProviderSelectionMenu.tsx`, `SettingsSelectionMenu.tsx`, `SettingsValueSelectionMenu.tsx`, `PathSelectionMenu.tsx`, `UndoSelectionMenu.tsx`
  - `prompt/` — `ApprovalPrompt.tsx`, `HandoffConfirmationPrompt.tsx`, `LargeUncachedConfirmationPrompt.tsx`
  - `common/` — `MenuContainer.tsx`, `ScrollableTabBar.tsx`, `compute-visible-tabs.ts`
  Top-level: `ErrorBoundary.tsx`, `InputBox.tsx`, `MarkdownRenderer.tsx`, `theme.ts`
- **Context** (`source/context/`): React context providers — `InputContext.tsx`
- **Utils** (`source/utils/`): Utilities organized by domain:
  - `ai/` — `flex-service-tier.ts`, `model-provider-arg.ts`, `model-settings.ts`, `provider-credentials.ts`, `provider-traffic-extractor.ts`, `token-usage.ts`
  - `conversation/` — `conversation-event-handler.ts`, `conversation-utils.ts`, `message-buffer.ts`, `message-utils.ts`
  - `output/` — `diff.ts`, `log-truncation.ts`, `log-viewer-filters.ts`, `output-trim.ts`, `synchronized-output.ts`, `trim-tool-output.ts`, `tty-osc.ts`, `viewport.ts`
  - `shell/` — `command-logger.ts`, `execute-shell.ts`
  - `streaming/` — `extract-command-messages.ts`, `streaming-session-factory.ts`, `streaming-updater.ts`
- **Types** (`source/types/`): TypeScript type definitions — `message.ts`, `user-turn.ts`
- **Contracts** (`source/contracts/`): Shared interfaces — `conversation.ts`
- **Scripts** (`source/scripts/`): Standalone utility scripts — `extract-provider-traffic.ts`

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` hook calls `conversationService.sendMessage()`
3. `ConversationService` (thin facade, `source/services/conversation/conversation-service.ts`) delegates to `ConversationSession`, which is itself a thin shell — it holds session identity (`id`, `startedAt`) and forwards `run()` / `continueAfterApproval()` calls to `TurnCoordinator` via `session-composition.ts`
4. `TurnCoordinator.start()` orchestrates the initial turn: it guards against concurrent turns via `TurnStatusMachine`, checks for stale/aborted approval state via `ApprovalFlowCoordinator`, then delegates execution to `InitialTurnRunner`
5. `InitialTurnRunner` builds agent input via `SessionInputPlanner`, drives the agent via `source/lib/agent-client.ts`, feeds the stream to `SessionStreamProcessor`, and returns an `InitialTurnOutcome` (`response`, `approval_required`, or `stale`)
6. `ConversationAdapter` provides the legacy `sendMessage`/`handleApprovalDecision` surface and wires directly to `TurnCoordinator` (no round-trip through `ConversationSession`)
7. The agent client selects a provider through the Provider Registry and streams the response
8. Tool requests are validated by `ApprovalFlowCoordinator` and paused for user approval; `TurnStatusMachine` transitions to `awaiting_approval`
9. User approves/rejects via `ApprovalPrompt` component; `TurnCoordinator.continueAfterApproval()` delegates to `ContinuationDriver`, which handles the decision and may signal `approval_required` (another tool needs approval), `fresh_start_required` (retry via a new `InitialTurnRunner` run), or `stale` (generation mismatch, no-op)
10. Retry logic in `services/retry/` classifies errors and handles recovery; `ContinuationDriver` surfaces `fresh_start_required` with retry counts/delay so `TurnCoordinator` can re-drive via `InitialTurnRunner`
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
