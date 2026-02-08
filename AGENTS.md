# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

**Key features**: streaming responses, command approval flow, slash commands (`/clear`, `/quit`, `/model`, `/setting`), input history, markdown rendering in the terminal, tool hallucination retry logic, multi-provider support, SSH mode for remote execution, and non-interactive mode for CLI usage.

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

- **Entry Points**: `source/cli.tsx` (entry), `source/app.tsx` (main React component)
- **State & Logic**:
  - `source/hooks/` - UI state (conversation, slash commands, input history, settings)
  - `source/services/` - Business logic (conversation flow, approval, logging, history, settings, SSH)
- **Agent & Tools**:
  - `source/agent.ts` - Agent configuration
  - `source/lib/openai-agent-client.ts` - Agent client with tool interceptor pattern
  - `source/providers/` - Pluggable provider registry (OpenAI, OpenRouter, OpenAI-compatible)
  - `source/tools/` - Tool implementations (shell, search-replace, grep, apply-patch, ask-mentor, find-files, read-file, web-search)
  - `source/prompts/` - System prompts for different model types
- **UI**: `source/components/` - React Ink components for terminal rendering
- **Utils**: `source/utils/` - Command safety, diff generation, output sanitization
- **Types**: `source/types/` - TypeScript type definitions
- **Context**: `source/context/` - React context providers
- **Docs**: `docs/agent-instructions.md`, `tsconfig.json`, `package.json`

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` hook sends it to `conversation-service.ts`
3. Service calls the agent via `openai-agent-client.ts`, which selects a provider through the Provider Registry
4. Agent response streams back in real-time with text, reasoning, and tool requests
5. Tool requests are validated and paused for user approval before execution
6. User approves/rejects via approval prompts
7. Service executes the tool or continues streaming
8. Final response appears in the message list

## Architecture highlights

High-level architecture and design decisions (concise):

- **Pluggable provider registry** with dependency-injected runner creation. Providers (e.g. OpenAI, OpenRouter, OpenAI-compatible) register via `source/providers` and may expose a `createRunner(deps)` factory so runners can be constructed without circular imports.
- **Provider-neutral conversation strategy**: a client-side `ConversationStore` is used where providers don't manage server-side state; when supported we pass `previousResponseId` to OpenAI to enable server-side chaining.
- **Tool interceptor and approval model**: tools (shell, apply-patch, search-replace, grep, ask-mentor) run through centralized validation and an approval flow; utilities provide safe diff generation and output sanitization.
- **Tool hallucination retry logic**: automatic retry with partial stream recovery when the agent hallucinates tool responses (MAX_HALLUCINATION_RETRIES = 2). The system detects when an agent provides a tool result instead of calling the tool, discards the hallucinated response, and retries the request.
- **Upstream retry logic**: configurable retry attempts (default: 2) with exponential backoff for OpenRouter and other providers to handle transient upstream failures.
- **Dependency injection and testability**: services accept interfaces (logging, settings) and a `SettingsService` mock exists to simplify unit tests and avoid I/O in tests.
- **Session & streaming model**: conversation sessions stream deltas, capture reasoning separately for O1/O3 models, and surface tool calls for explicit approval; retry and failure-tracking behavior is configurable.
- **App mode support**: default mode requires approval for all tools; edit mode auto-approves apply_patch operations for faster file editing workflows.
- **Reasoning effort control**: supports reasoning effort levels (none, minimal, low, medium, high, default) for O1/O3 models with dynamic configuration.
- **Decentralized tool message formatting**: Tool command message formatting is co-located with tool implementations to ensure self-contained tool definitions and prevent extraction logic drift.
- **Web search provider registry**: Pluggable web search architecture allows swapping between providers (Tavily, Serper, Brave, etc.) via settings without code changes. Providers implement `IWebSearchProvider` interface and register via registry.
- **SSH mode for remote execution**: Optional `--ssh user@host` flag enables remote command execution and file operations over SSH. Uses `ssh2` library with SSH agent authentication. An `ExecutionContext` abstraction allows tools to transparently execute locally or remotely.
- **Non-interactive mode**: Passing a positional argument to the CLI triggers non-interactive mode (implemented in `source/non-interactive.ts`). It redirects AI responses to stdout and events to stderr. By default, it rejects tools requiring approval unless `--auto-approve` is provided. It defaults to lite mode when not auto-approving. Returns exit code 0 on success and 1 on error.

For implementation details, chronological change logs, and rationale, consult the source files under `source/` and the Git history — this document intentionally stays at a high level.

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.
After making code changes, you MUST run the tests and report the results.

```bash
npm test              # Run all tests
npx prettier --check . # Format check
npx ava               # Unit tests
```

**Note**: When running `npx ava` on a single test file, use the compiled version in the `dist/` directory (e.g., `npx ava dist/path/to/test.js`), not the TypeScript source file.

## Key Concepts

- **Tool Interceptors**: Centralized validation and approval flow for all tools
- **Tool Approval**: Tools validate operations before execution; valid requests pause for user approval (except in edit mode for patches)
- **Tool Hallucination Recovery**: Automatic detection and retry when agent hallucinates tool results instead of calling tools
- **Failure Tracking**: Consecutive tool failures trigger automatic abort after threshold (default: 3)
- **Streaming**: Responses and reasoning stream in real-time with separate reasoning channel for O1/O3 models
- **Provider Registry**: Pluggable provider support (OpenAI, OpenRouter, OpenAI-compatible) with dependency injection
- **Conversation Store**: Client-side history for providers without server-side state management
- **Reasoning Effort**: Configurable reasoning levels for O1/O3 models (none, minimal, low, medium, high, default)
- **App Modes**: Default mode (manual approval) vs edit mode (auto-approve patches for faster workflows)
- **Web Search Providers**: Pluggable architecture for search providers (Tavily default); implement `IWebSearchProvider` interface to add custom providers; registry enables runtime provider selection via settings
- **SSH Mode**: Remote execution over SSH via `--ssh user@host --remote-dir /path` flags; uses `ExecutionContext` to abstract local vs remote execution; compatible with lite mode for lightweight remote assistance
- **Execution Context**: Abstraction layer that tools query via `isRemote()` to branch between local and SSH execution paths

## Where to Look

- **Adding a new slash command?** → `source/hooks/use-slash-commands.ts`
- **Modifying agent behavior?** → `docs/agent-instructions.md` and `source/prompts/`
- **Adding a new tool?** → Create in `source/tools/` (including `formatCommandMessage`), add to `source/agent.ts`
- **Adding a new web search provider?** → Create in `source/providers/web-search/`, implement `IWebSearchProvider`, register in `source/providers/web-search/registry.ts`
- **Adding a new provider?** → Create in `source/providers/`, register in provider registry
- **Changing the UI?** → Components in `source/components/`
- **Debugging message flow?** → Check `source/services/conversation-service.ts` and `conversation-session.ts`
- **Styling/Output format?** → Components use Ink for terminal UI
- **Adding a new setting?** → `source/services/settings-service.ts` (update schema and defaults)
- **Command safety validation?** → `source/utils/command-safety.ts`
- **Diff generation?** → `source/utils/diff-utils.ts`
- **Modifying configuration?** → Edit `~/Library/Logs/term2-nodejs/settings.json` (macOS) or `~/.local/state/term2-nodejs/settings.json` (Linux), or use environment variables / CLI flags
- **Web search configuration?** → `source/services/settings-service.ts` (webSearch settings), `source/providers/web-search/registry.ts` (provider lookup), environment variable `TAVILY_API_KEY`
- **Testing?** → See `test/` directory for test utilities, test files are co-located with source files
- **SSH mode?** → `source/services/ssh-service.ts` (SSH connection and operations), `source/services/execution-context.ts` (local/remote abstraction)

## Resources

- [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)

## Notes

Please keep this document up to date with major architectural changes, but avoid excessive detail that may become outdated quickly. Focus on high-level structure and key components.
