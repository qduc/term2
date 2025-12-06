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