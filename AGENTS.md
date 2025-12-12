# What Is This

This is a terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js.

## What It Does

A CLI app that lets users chat with an AI agent in real-time. The agent can execute shell commands and modify files, with interactive approval prompts for safety.

**Key features**: streaming responses, command approval flow, slash commands (`/clear`, `/quit`, `/model`), input history, and markdown rendering in the terminal.

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

### Entry Points

-   **`source/cli.tsx`** - Minimal CLI entry point
-   **`source/app.tsx`** - Main React component with slash command and input history support

### State & Logic

-   **`source/hooks/`** - React hooks managing UI state

    -   `use-conversation.ts` - Conversation state and streaming responses
    -   `use-slash-commands.ts` - Slash command menu
    -   `use-input-history.ts` - Input history navigation

-   **`source/services/`** - Business logic independent of React
    -   `conversation-service.ts` - Agent runs and approval flow
    -   `history-service.ts` - Persistent input history storage
    -   `logging-service.ts` - Winston-based logging with security audit trails

### Agent, Providers & Tools

-   **`source/agent.ts`** - Configures the agent with available tools
-   **`source/lib/openai-agent-client.ts`** - Minimal agent client adapter with tool interceptor pattern for enhanced execution control
-   **`source/providers/`** - Provider registry and implementations to support multiple backends
    - `index.ts` / `registry.ts` - Lightweight provider registry (no hard imports in app code)
    - `openai.provider.ts` - OpenAI provider definition
    - `openrouter.provider.ts` - OpenRouter provider definition (uses custom runner)
-   **`source/tools/`** - Tool implementations
    -   `shell.ts` - Execute commands (with safety validation and approval)
    -   `search-replace.ts` - Replace text in files with exact or relaxed matching (supports file creation)
    -   `grep.ts` - Search for patterns in files (renamed from `search` for consistency)
    -   `apply-patch.ts` - Modify files using unified diff format (with pre-approval validation and consecutive failure tracking)
    -   `tool-execution-context.ts` - Deprecated (replaced with instance-based interceptor pattern)
    -   `types.ts` - Shared tool type definitions

### State & Conversation

-   **`source/services/conversation-store.ts`** - Canonical conversation history when a provider does not support server-managed conversations (e.g., OpenRouter)

### UI Components

-   **`source/components/`** - React Ink components
    -   `MessageList.tsx`, `ChatMessage.tsx` - Display conversation
    -   `InputBox.tsx` - User input
    -   `LiveResponse.tsx` - Stream agent responses in real-time
    -   `ApprovalPrompt.tsx` - Y/N prompt for tool approval
    -   `CommandMessage.tsx` - Show executed commands and output
    -   `SlashCommandMenu.tsx` - Command menu UI
    -   `MarkdownRenderer.tsx` - Render markdown in terminal

### Config & Docs

-   **`docs/agent-instructions.md`** - Instructions loaded into the agent
-   **`tsconfig.json`** - TypeScript configuration
-   **`package.json`** - Dependencies and npm scripts

## How It Works

1. User types a message → `app.tsx` captures it
2. `use-conversation.ts` hook sends it to `conversation-service.ts`
3. Service calls the agent via `openai-agent-client.ts`, which selects a provider through the Provider Registry
4. Agent response streams back in real-time:
    - Text and reasoning displayed by `LiveResponse.tsx`
    - Tool requests (shell/search-replace/grep/apply-patch) are validated before approval
    - Tool interceptors provide centralized execution control (custom validation, approval flow, error handling)
    - Invalid patches are rejected immediately (dry-run validation)
    - Valid tool requests pause for approval
5. User approves/rejects via `ApprovalPrompt.tsx` or `SearchReplacePrompt.tsx`
6. Service executes the tool or continues streaming
7. Final response appears in `MessageList.tsx`
8. Consecutive tool failures trigger automatic abort after threshold

### Provider Selection and Runner Creation

The app now supports pluggable providers via a tiny registry layer:

- `source/providers/registry.ts` exposes a `ProviderDefinition` interface and global registry helpers (`registerProvider`, `getProvider`, `getAllProviders`).
- Each provider registers itself on module load (see `source/providers/index.ts`).
- A provider can optionally supply a `createRunner(deps)` factory to construct a custom `Runner` from `@openai/agents` with injected dependencies, avoiding circular imports.
  - OpenAI provider: `createRunner` is `undefined`, using the SDK default runner.
  - OpenRouter provider: returns a `Runner` with a custom `modelProvider` implementation.

OpenAIAgentClient delegates runner creation to the active provider definition. Dependencies (e.g., `settingsService`, `loggingService`) are passed into `createRunner` rather than imported directly to preserve ESM boundaries.

### Conversation State Strategy

Different providers handle conversation context differently:

- OpenAI (Responses API): supports server-managed conversation chaining. We pass `previousResponseId` when available so the server can derive context without resending full history.
- OpenRouter: does not support `previousResponseId` or server-side state. The app maintains a local, canonical history via `ConversationStore` and sends the full client-managed transcript each turn.

`ConversationService` integrates `ConversationStore`, updates it from streaming results, and tracks `previousResponseId` when using OpenAI so follow-up turns can chain efficiently.

### Tooling and Output Updates

Recent changes improved consistency and safety across tools:

- Shell tool uses a single `command` string (replacing the older `commands` array) and renders compact, human-readable outputs.
- Search/Replace tool shows a diff preview and supports approval with clear failure reasons; diff generation is centralized in a `generateDiff` utility.
- Grep tool returns a plain human-readable string (trimmed) instead of JSON.
- Tools array sanitization and deep content truncation reduce noisy logs while preserving key context.

### Testing Support

- SettingsService now has a light-weight mock for tests to isolate configuration and simplify overrides. Provider `createRunner` accepts `settingsService` and `loggingService` via DI for easier test scaffolding and to avoid import cycles.

## Recent Architecture Changes (since commit 5e48382)

The following significant architectural changes have been introduced after commit `5e48382`:

1. Provider Registry and DI-based Runner Creation
   - Introduced `ProviderDefinition` with optional `createRunner(deps)`.
   - Providers self-register (`source/providers/index.ts`).
   - `OpenRouter` builds a custom `Runner` with its own `modelProvider`; `OpenAI` uses the default SDK runner.

2. Conversation State Management
   - Added `ConversationStore` for maintaining canonical client-side history.
   - OpenAI path supports `previousResponseId` chaining; OpenRouter ignores it and relies on the local history.
   - Removed OpenRouter-side conversation state management in favor of caller-managed history.

3. Safer, More Consistent Tooling
   - Shell tool standardized on `command` string; command message rendering improved.
   - Search/Replace enhanced with diff previews and pre-approval validation.
   - Utilities added for diff generation and tools array sanitization; grep returns plain text.

4. Dependency Injection for Providers
   - `createRunner` accepts `{ settingsService, loggingService }` from the caller to avoid ESM circular dependencies and improve testability.

5. Testing Improvements
   - Introduced a `SettingsService` mock for isolation in unit tests.

These changes make it easier to add new providers, reduce coupling, and clarify how conversation context is managed across backends.

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.

```bash
npm test              # Run all tests
npx prettier --check . # Format check
npx ava               # Unit tests
```

## Key Concepts

-   **Message Types**: UserMessage, BotMessage, ReasoningMessage, ApprovalMessage, CommandMessage, SystemMessage
-   **Tool Interceptors**: Instance-based pattern in `OpenAIAgentClient` for enhanced execution control. Tools register interceptors via `addToolInterceptor()` for custom validation, approval flow, and error handling before/after execution
-   **Tool Approval**: Tools like `shell.ts` and `search-replace.ts` validate operations and can require user approval before execution
-   **Patch Validation**: The `apply-patch` tool performs dry-run validation before requesting approval, rejecting malformed diffs immediately
-   **Failure Tracking**: Consecutive tool failures are tracked; after N failures (configurable, default: 3), the agent automatically aborts to prevent infinite retry loops
-   **Streaming**: Responses and reasoning stream in real-time for responsive UX
-   **Input History**: Persisted to `~/Library/Logs/term2-nodejs/history.json` (macOS) or `~/.local/state/term2/history.json` (Linux), navigable with arrow keys
-   **Logging**: Winston-based system logs shell commands, API calls, and errors to `~/Library/Logs/term2-nodejs/logs/` (macOS) or `~/.local/state/term2/logs/` (Linux)
-   **Settings**: Centralized configuration system with hierarchical precedence (CLI > Env > Config > Defaults)
-   **Pure Functions**: Core logic separated from side effects for testability and maintainability (see Architecture Patterns below)
-   **Message Type Conversion**: Proper handling of function_call and function_call_output types between OpenRouter and agent SDK message formats

## Architecture Patterns

### Pure Functions for Complex UI Logic

For complex state management (multiple menus, input parsing, etc.), **extract decision logic into pure functions** that return discriminated unions, then handle side effects separately.

**Examples**: `determineActiveMenu()` in `InputBox.tsx`, `parseInput()` in `app.tsx`

**Why**: Testable with table-driven tests, prevents race conditions, explicit state transitions

**When**: Multiple mutually-exclusive states, complex conditionals, need comprehensive test coverage

## Configuration System

Term2 uses a centralized settings service with XDG-compliant storage and flexible precedence.

### Sensitive Settings

Some settings contain sensitive data (API keys, system paths) and **are never saved to the config file**. They can only be configured via environment variables:

-   **`agent.openrouter.apiKey`** - OpenRouter API key (env: `OPENROUTER_API_KEY`)
-   **`agent.openrouter.baseUrl`** - OpenRouter base URL (env: `OPENROUTER_BASE_URL`)
-   **`agent.openrouter.referrer`** - OpenRouter referrer (env: `OPENROUTER_REFERRER`)
-   **`agent.openrouter.title`** - OpenRouter app title (env: `OPENROUTER_TITLE`)
-   **`app.shellPath`** - Shell path (env: `SHELL` or `COMSPEC`)

These values are loaded into memory at startup from environment variables and remain accessible at runtime, but are **never written to disk**. Attempting to modify these settings via the `set()` or `reset()` methods will throw an error.

### Settings File

-   **Location**:
    -   **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
    -   **Linux**: `~/.local/state/term2-nodejs/settings.json`
    -   **Windows**: `%APPDATA%\term2\settings.json`
-   **Format**: JSON with validated schema
-   **Precedence**: CLI flags > Environment variables > Config file > Defaults
-   **Note**: File is created on-demand when you first save settings. Until then, default settings are used.
-   **Security**: Sensitive settings are filtered out before saving to disk

### Supported Settings

| Setting                            | Default   | Runtime?  | Purpose                                                                                       |
| ---------------------------------- | --------- | --------- | --------------------------------------------------------------------------------------------- |
| `agent.model`                      | `gpt-5.1` | ✓ Yes     | OpenAI model to use                                                                           |
| `agent.reasoningEffort`            | `default` | ✓ Yes     | Reasoning effort for reasoning models (`default`, `none`, `minimal`, `low`, `medium`, `high`) |
| `agent.maxTurns`                   | `20`      | ✗ Startup | Maximum turns per agent run                                                                   |
| `agent.retryAttempts`              | `2`       | ✗ Startup | Retry attempts for failed operations                                                          |
| `agent.maxConsecutiveToolFailures` | `3`       | ✗ Startup | Maximum consecutive malformed patches before aborting                                         |
| `shell.timeout`                    | `120000`  | ✓ Yes     | Shell command timeout in milliseconds                                                         |
| `shell.maxOutputLines`             | `1000`    | ✓ Yes     | Maximum lines of command output                                                               |
| `shell.maxOutputChars`             | `10000`   | ✓ Yes     | Maximum characters of command output                                                          |
| `ui.historySize`                   | `1000`    | ✗ Startup | Maximum input history entries                                                                 |
| `logging.logLevel`                 | `info`    | ✓ Yes     | Log level (`error`, `warn`, `info`, `security`, `debug`)                                      |

### Environment Variables

Override settings via environment variables:

```bash
# OpenAI / Agent Settings
OPENAI_MODEL=gpt-4o              # Set model
REASONING_EFFORT=medium           # Set reasoning effort
MAX_TURNS=30                       # Set max turns (requires restart)
RETRY_ATTEMPTS=3                  # Set retry attempts (requires restart)

# OpenRouter Settings (Sensitive - env only)
OPENROUTER_API_KEY=sk-...         # OpenRouter API key
OPENROUTER_MODEL=gpt-4            # OpenRouter model
OPENROUTER_BASE_URL=https://...   # OpenRouter base URL
OPENROUTER_REFERRER=myapp         # OpenRouter referrer
OPENROUTER_TITLE="My App"         # OpenRouter app title

# Shell Settings
SHELL_TIMEOUT=60000               # Set shell timeout
MAX_OUTPUT_LINES=2000             # Set max output lines
MAX_OUTPUT_CHARS=20000            # Set max output chars

# UI Settings
HISTORY_SIZE=2000                 # Set history size (requires restart)

# Logging Settings
LOG_LEVEL=debug                   # Set log level

# System Settings (Sensitive - env only)
SHELL=/bin/bash                   # Shell path
```

### Example Config File

```json
{
    "agent": {
        "model": "gpt-4o",
        "reasoningEffort": "medium",
        "maxTurns": 30,
        "retryAttempts": 3,
        "provider": "openai",
        "openrouter": {
            "model": "gpt-4"
        }
    },
    "shell": {
        "timeout": 60000,
        "maxOutputLines": 2000,
        "maxOutputChars": 20000
    },
    "ui": {
        "historySize": 2000
    },
    "logging": {
        "logLevel": "debug"
    }
}
```

**Note**: Sensitive fields (`apiKey`, `baseUrl`, `referrer`, `title`, `shellPath`) are never saved to this file.

### Runtime vs Startup-Only Settings

**Runtime-modifiable** settings can be changed during execution and are persisted immediately:

-   `agent.model` - Change model mid-session
-   `agent.reasoningEffort` - Adjust reasoning level
-   `shell.timeout` - Adjust command timeouts
-   `shell.maxOutputLines` - Adjust output truncation
-   `shell.maxOutputChars` - Adjust output truncation
-   `logging.logLevel` - Adjust logging verbosity

**Startup-only** settings require a restart to take effect:

-   `agent.maxTurns` - Recreates agent
-   `agent.retryAttempts` - Used during initialization
-   `ui.historySize` - Affects history loading
-   (Future: other settings requiring structural changes)

## Logging

Term2 includes a robust logging system for debugging and security auditing:

### Log Locations

-   **Linux**: `~/.local/state/term2/logs/term2-YYYY-MM-DD.log`
-   **macOS**: `~/Library/Logs/term2-nodejs/logs/term2-YYYY-MM-DD.log` (or use env-paths for exact location)
-   **Windows**: `%APPDATA%\term2\logs\term2-YYYY-MM-DD.log`

### Environment Variables

| Variable              | Default | Purpose                                               |
| --------------------- | ------- | ----------------------------------------------------- |
| `LOG_LEVEL`           | `info`  | Minimum log level: error, warn, info, debug, security |
| `DISABLE_LOGGING`     | `false` | Disable file logging                                  |
| `LOG_FILE_OPERATIONS` | `true`  | Enable apply-patch operation logging                  |
| `DEBUG_LOGGING`       | unset   | Enable console output in production                   |

### What Gets Logged

-   **Security events**: Shell command execution with danger flags
-   **Command execution**: Start, completion, failures, timeouts (with truncated output)
-   **API operations**: OpenAI client initialization, stream operations, retries, errors
-   **File operations**: File create/update/delete operations (when enabled)
-   **System errors**: File I/O failures, workspace entry loading errors

### Viewing Logs

```bash
npm run logs:view    # Stream logs with jq filtering (cross-platform)
npm run logs:clean   # Remove all log files (cross-platform)
```

The log viewer includes:
-   **Real-time file monitoring** via Server-Sent Events (SSE) for auto-refresh
-   **Reverse order display** showing newest log lines first
-   **Improved scrolling behavior** for better UX when viewing large log files

If you need to inspect the path manually, run a quick Node command to discover the env-paths location:

```bash
node -e "import envPaths from 'env-paths'; console.log(envPaths('term2').log)"
```

### Log Format

Logs are JSON-formatted with timestamps, correlation IDs for tracing related operations, and structured metadata:

```json
{
    "timestamp": "2025-12-06 17:49:30",
    "level": "info",
    "message": "Shell command execution started",
    "commandCount": 1,
    "timeout": 120000,
    "correlationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Log Retention

-   Maximum file size: 10MB per day
-   Retention period: 14 days
-   Automatic rotation based on date and size

## Where to Look

-   **Adding a new slash command?** → `use-slash-commands.ts`
-   **Modifying agent behavior?** → `docs/agent-instructions.md`
-   **Adding a new tool?** → Create in `source/tools/`, add to `agent.ts`
-   **Changing the UI?** → Components in `source/components/`
-   **Debugging message flow?** → Check `conversation-service.ts`
-   **Styling/Output format?** → Components use Ink for terminal UI
-   **Adding a new setting?** → `source/services/settings-service.ts` (update schema and defaults)
-   **Modifying configuration?** → Edit `~/Library/Logs/term2-nodejs/settings.json` (macOS) or `~/.local/state/term2-nodejs/settings.json` (Linux), or use environment variables / CLI flags

## Resources

-   [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)

## Notes

Please keep this document up to date with major architectural changes, but avoid excessive detail that may become outdated quickly. Focus on high-level structure and key components.
