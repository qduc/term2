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
- **`source/cli.tsx`** - Minimal CLI entry point
- **`source/app.tsx`** - Main React component with slash command and input history support

### State & Logic
- **`source/hooks/`** - React hooks managing UI state
  - `use-conversation.ts` - Conversation state and streaming responses
  - `use-slash-commands.ts` - Slash command menu
  - `use-input-history.ts` - Input history navigation

- **`source/services/`** - Business logic independent of React
  - `conversation-service.ts` - Agent runs and approval flow
  - `history-service.ts` - Persistent input history storage
  - `logging-service.ts` - Winston-based logging with security audit trails

### Agent & Tools
- **`source/agent.ts`** - Configures the OpenAI agent with available tools
- **`source/tools/`** - Tool implementations
  - `shell.ts` - Execute commands (with safety validation and approval)
  - `apply-patch.ts` - Modify files using unified diff format
  - `types.ts` - Shared tool type definitions

### UI Components
- **`source/components/`** - React Ink components
  - `MessageList.tsx`, `ChatMessage.tsx` - Display conversation
  - `InputBox.tsx`, `TextInput.tsx` - User input
  - `LiveResponse.tsx` - Stream agent responses in real-time
  - `ApprovalPrompt.tsx` - Y/N prompt for tool approval
  - `CommandMessage.tsx` - Show executed commands and output
  - `SlashCommandMenu.tsx` - Command menu UI
  - `MarkdownRenderer.tsx` - Render markdown in terminal

### Config & Docs
- **`docs/agent-instructions.md`** - Instructions loaded into the agent
- **`tsconfig.json`** - TypeScript configuration
- **`package.json`** - Dependencies and npm scripts

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

- **Message Types**: UserMessage, BotMessage, ReasoningMessage, ApprovalMessage, CommandMessage, SystemMessage
- **Tool Approval**: Tools like `shell.ts` validate commands and can require user approval before execution
- **Streaming**: Responses and reasoning stream in real-time for responsive UX
- **Input History**: Persisted to `~/.local/state/term2/history.json`, navigable with arrow keys
- **Logging**: Winston-based system logs shell commands, API calls, and errors to `~/.local/state/term2/logs/`

## Logging

Term2 includes a robust logging system for debugging and security auditing:

### Log Locations
- **Linux/macOS**: `~/.local/state/term2/logs/term2-YYYY-MM-DD.log`
- **Windows**: `%APPDATA%\term2\logs\term2-YYYY-MM-DD.log`

### Environment Variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `info` | Minimum log level: error, warn, info, debug, security |
| `DISABLE_LOGGING` | `false` | Disable file logging |
| `LOG_FILE_OPERATIONS` | `true` | Enable apply-patch operation logging |
| `DEBUG_LOGGING` | unset | Enable console output in production |

### What Gets Logged
- **Security events**: Shell command execution with danger flags
- **Command execution**: Start, completion, failures, timeouts (with truncated output)
- **API operations**: OpenAI client initialization, stream operations, retries, errors
- **File operations**: File create/update/delete operations (when enabled)
- **System errors**: File I/O failures, workspace entry loading errors

### Viewing Logs
```bash
npm run logs:view    # Stream logs with jq filtering
npm run logs:clean   # Remove all log files
tail -f ~/.local/state/term2/logs/term2-$(date +%Y-%m-%d).log | jq .
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
- Maximum file size: 10MB per day
- Retention period: 14 days
- Automatic rotation based on date and size

## Where to Look

- **Adding a new slash command?** → `use-slash-commands.ts`
- **Modifying agent behavior?** → `docs/agent-instructions.md`
- **Adding a new tool?** → Create in `source/tools/`, add to `agent.ts`
- **Changing the UI?** → Components in `source/components/`
- **Debugging message flow?** → Check `conversation-service.ts`
- **Styling/Output format?** → Components use Ink for terminal UI

## Resources

- [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)

## Notes

Please keep this document up to date with major architectural changes, but avoid excessive detail that may become outdated quickly. Focus on high-level structure and key components.