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

### Agent & Tools

-   **`source/agent.ts`** - Configures the OpenAI agent with available tools
-   **`source/tools/`** - Tool implementations
    -   `shell.ts` - Execute commands (with safety validation and approval)
    -   `apply-patch.ts` - Modify files using unified diff format
    -   `types.ts` - Shared tool type definitions

### UI Components

-   **`source/components/`** - React Ink components
    -   `MessageList.tsx`, `ChatMessage.tsx` - Display conversation
    -   `InputBox.tsx`, `TextInput.tsx` - User input
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
3. Service calls the OpenAI agent via `openai-agent-client.ts`
4. Agent response streams back in real-time:
    - Text and reasoning displayed by `LiveResponse.tsx`
    - Tool requests (shell/apply-patch) pause for approval
5. User approves/rejects via `ApprovalPrompt.tsx`
6. Service executes the tool or continues streaming
7. Final response appears in `MessageList.tsx`

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.

```bash
npm test              # Run all tests
npx prettier --check . # Format check
npx xo                # Lint
npx ava               # Unit tests
```

## Key Concepts

-   **Message Types**: UserMessage, BotMessage, ReasoningMessage, ApprovalMessage, CommandMessage, SystemMessage
-   **Tool Approval**: Tools like `shell.ts` validate commands and can require user approval before execution
-   **Streaming**: Responses and reasoning stream in real-time for responsive UX
-   **Input History**: Persisted to `~/Library/Logs/term2-nodejs/history.json` (macOS) or `~/.local/state/term2/history.json` (Linux), navigable with arrow keys
-   **Logging**: Winston-based system logs shell commands, API calls, and errors to `~/Library/Logs/term2-nodejs/logs/` (macOS) or `~/.local/state/term2/logs/` (Linux)
-   **Settings**: Centralized configuration system with hierarchical precedence (CLI > Env > Config > Defaults)

## Configuration System

Term2 uses a centralized settings service with XDG-compliant storage and flexible precedence.

### Settings File

-   **Location**:
    -   **macOS**: `~/Library/Logs/term2-nodejs/settings.json`
    -   **Linux**: `~/.local/state/term2/settings.json`
    -   **Windows**: `%APPDATA%\term2\settings.json`
-   **Format**: JSON with validated schema
-   **Precedence**: CLI flags > Environment variables > Config file > Defaults
-   **Note**: File is created on-demand when you first save settings. Until then, default settings are used.

### Supported Settings

| Setting                 | Default   | Runtime?  | Purpose                                                                                       |
| ----------------------- | --------- | --------- | --------------------------------------------------------------------------------------------- |
| `agent.model`           | `gpt-5.1` | ✓ Yes     | OpenAI model to use                                                                           |
| `agent.reasoningEffort` | `default` | ✓ Yes     | Reasoning effort for reasoning models (`default`, `none`, `minimal`, `low`, `medium`, `high`) |
| `agent.maxTurns`        | `20`      | ✗ Startup | Maximum turns per agent run                                                                   |
| `agent.retryAttempts`   | `2`       | ✗ Startup | Retry attempts for failed operations                                                          |
| `shell.timeout`         | `120000`  | ✓ Yes     | Shell command timeout in milliseconds                                                         |
| `shell.maxOutputLines`  | `1000`    | ✓ Yes     | Maximum lines of command output                                                               |
| `shell.maxOutputChars`  | `10000`   | ✓ Yes     | Maximum characters of command output                                                          |
| `ui.historySize`        | `1000`    | ✗ Startup | Maximum input history entries                                                                 |
| `logging.logLevel`      | `info`    | ✓ Yes     | Log level (`error`, `warn`, `info`, `security`, `debug`)                                      |

### Environment Variables

Override settings via environment variables:

```bash
OPENAI_MODEL=gpt-4o              # Set model
REASONING_EFFORT=medium           # Set reasoning effort
MAX_TURNS=30                       # Set max turns (requires restart)
RETRY_ATTEMPTS=3                  # Set retry attempts (requires restart)
SHELL_TIMEOUT=60000               # Set shell timeout
MAX_OUTPUT_LINES=2000             # Set max output lines
MAX_OUTPUT_CHARS=20000            # Set max output chars
HISTORY_SIZE=2000                 # Set history size (requires restart)
LOG_LEVEL=debug                   # Set log level
```

### Example Config File

```json
{
	"agent": {
		"model": "gpt-4o",
		"reasoningEffort": "medium",
		"maxTurns": 30,
		"retryAttempts": 3
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
-   **Modifying configuration?** → Edit `~/Library/Logs/term2-nodejs/settings.json` (macOS) or `~/.local/state/term2/settings.json` (Linux), or use environment variables / CLI flags

## Resources

-   [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)

## Notes

Please keep this document up to date with major architectural changes, but avoid excessive detail that may become outdated quickly. Focus on high-level structure and key components.
