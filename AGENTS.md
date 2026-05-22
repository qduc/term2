# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

**Key features**: streaming responses, command approval flow, slash commands (e.g. `/clear`, `/quit`, `/model`, `/settings`, `/mentor`, `/lite`, `/plan`, `/undo`, `/usage`, `/effort`, `/copy`), input history, markdown rendering, tool hallucination retry logic, multi-provider support, SSH mode for remote execution, non-interactive mode, subagent delegation, plan mode, undo/rewind, and conversation persistence.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Set your OpenAI API key**
   ```bash
   export OPENAI_API_KEY=your-key-here
   ```
3. **Run the app**
   ```bash
   npm run dev    # Watch mode
   npm run build  # Compile TypeScript
   node dist/cli.js  # Run the CLI
   ```

## Project Structure

- **Entry Points**: `cli.tsx` (entry), `app.tsx` (main React component)
    - **State & Logic**:
      - `source/hooks/` - UI state (conversation, slash commands, input history, settings)
      - `source/services/` - Business logic (conversation flow, approval, logging, history, settings, SSH, persistence, subagents)
    - **Agent & Tools**:
      - `agent.ts` - Agent configuration
      - `openai-agent-client.ts` - Agent client with tool interceptor pattern
      - `source/providers/` - Pluggable provider registry (OpenAI, OpenRouter, OpenAI-compatible, etc.)
      - `source/tools/` - Tool implementations (shell, search-replace, grep, apply-patch, ask-mentor, find-files, read-file, web-search, create-file, web-fetch, code-context, run-subagent)
      - `source/prompts/` - System prompts for different model types and subagents
    - **UI**: `source/components/` - React Ink components for terminal rendering
    - **Utils**: `source/utils/` - Command safety, diff generation, output sanitization
    - **Types**: `source/types/` - TypeScript type definitions
    - **Context**: `source/context/` - React context providers

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` hook sends it to `conversation-service.ts`
    3. Service calls the agent via `openai-agent-client.ts`, which selects a provider through the Provider Registry
4. Agent response streams back in real-time with text, reasoning, and tool requests
5. Tool requests are validated and paused for user approval before execution (except in standard mode for patches)
6. User approves/rejects via approval prompts
7. Service executes the tool or continues streaming
8. Final response appears in the message list

## Architecture Highlights

- **Pluggable Provider Registry**: Providers (e.g. OpenAI, OpenRouter, OpenAI-compatible) register via `source/providers/` with dependency-injected runner creation to avoid circular imports.
    - **Tool Interceptor and Approval Model**: Tools run through centralized validation and approval flow.
- **Tool Hallucination Retry Logic**: Automatic retry with partial stream recovery when the agent hallucinates tool responses (MAX_HALLUCINATION_RETRIES = 2).
- **Session & Streaming Model**: Conversation sessions stream deltas, capture reasoning separately, and surface tool calls.
- **App Mode Support**: standard, lite, mentor, and plan modes are supported. Lite mode is minimal-context; standard mode auto-approves apply_patch operations within workspace; plan mode is a cache-stable read-only mode for researching and proposing step-by-step implementation plans.
- **SSH Mode**: Execution of commands and file operations on remote servers over SSH.
- **Subagent Manager**: Equips the agent with `run_subagent` to delegate tasks to specialized synchronous subagents (`explorer`, `worker`, `researcher`, `mentor`) to conserve context.
- **Conversation State Persistence**: Automatic and manual session persistence, allowing resuming a conversation with `--resume`.
- **Undo / Rewind**: Allows user to select and rewind conversation to any past user message.

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.
After making code changes, you MUST run tests appropriate to the scope of the task and report the results.

- For small, localized changes: run focused tests for the affected area.
- For broad changes, architectural changes, shared utilities, or changes that may affect multiple areas: run the full test suite.
- If no relevant focused test exists, run the smallest applicable broader test command and explain why.

```bash
npm test              # Run all tests
npm test:verbose -- <source/*.test.ts>           # Run a single .ts source test
npm test:verbose -- dist/<path to compiled JS test file>  # Use for .tsx tests; dist paths omit the leading source/
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

## Provider Traffic Log Files

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


## Key Concepts

- **Tool Interceptors**: Centralized validation and approval flow.
- **Tool Approval**: Pauses for user approval (unless in standard mode).
- **Subagents**: Synchronous workers (`explorer`, `worker`, `researcher`, `mentor`) to isolate task execution.
- **Plan Mode**: Strict read-only mode that blocks file modifications and state-changing shell commands.
- **Undo/Rewind**: State rewinding capability.
- **Conversation Resumption**: Session serialization to resume later.

## Where to Look

- **Adding a slash command?** → `use-slash-commands.ts` and `use-app-commands.ts`
    - **Modifying agent behavior/prompts?** → `source/prompts/` and `agent.ts`
    - **Adding a new tool?** → Create in `source/tools/` and register in `agent.ts`
    - **Adding a new provider?** → Create in `source/providers/` and register in provider registry
    - **Changing the UI?** → `source/components/` and `app.tsx`
    - **Conversation persistence?** → `conversation-persistence.ts`
    - **Subagents?** → `run-subagent.ts` and `source/services/subagents/`
    - **Plan mode logic?** → `plan-mode-interceptor.ts`
    - **Web search config?** → `settings-service.ts` and `source/providers/web-search/`
    - **SSH mode?** → `ssh-service.ts` and `execution-context.ts`
    - **Command safety?** → `source/utils/command-safety/`
    - **Testing?** → See `test/` directory for test utilities. Use `npm run test:verbose -- <file>` or `npx ava <file>` to run specific tests. For `.tsx` tests, run via compiled files in `dist/` where the leading `source/` segment is stripped.
