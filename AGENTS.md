# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## Project Overview

This is a terminal-based AI assistant application built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js. The application provides an interactive CLI where users can chat with an AI agent that can execute shell commands and apply file patches with user approval. Features include:

-   **Streaming Responses**: Real-time display of agent responses including reasoning output
-   **Tool Approval Flow**: Interactive approval prompts for shell commands and file modifications
-   **Slash Commands**: Built-in commands like `/clear`, `/quit`, and `/model` for quick actions
-   **Input History**: Navigate previous inputs with up/down arrow keys (persisted across sessions)
-   **Markdown Rendering**: Rich text formatting in the terminal with support for headings, lists, code blocks, and inline formatting

## Architecture

The codebase follows a clean separation of concerns pattern with distinct layers:

### Key Components

-   **CLI Entry Point** (`source/cli.tsx`): Minimal entry point that renders the Ink React app
-   **Main App** (`source/app.tsx`): React component orchestrating the UI with slash command support and input history navigation
-   **Agent Definition** (`source/agent.ts`): Configures the OpenAI agent with shell and apply_patch tools, loads instructions from `docs/agent-instructions.md`
-   **Hooks** (`source/hooks/`):
    -   `use-conversation.ts`: Manages conversation state, messages (user, bot, reasoning, approval, command, system), streaming responses, and approval flow
    -   `use-slash-commands.ts`: Manages slash command menu state, filtering, and execution
    -   `use-input-history.ts`: Handles input history navigation with up/down arrows
-   **Services** (`source/services/`):
    -   `conversation-service.ts`: Business logic for agent runs, streaming responses (including reasoning), and approval decisions
    -   `history-service.ts`: Persistent input history storage using XDG directories (saves to `~/.local/state/term2/history.json`)
-   **OpenAI Agent Client** (`source/lib/openai-agent-client.ts`): Minimal adapter isolating usage of `@openai/agents` SDK
-   **Tools** (`source/tools/`):
    -   `shell.ts`: Shell command execution tool with safety validation, approval logic, and output trimming
    -   `apply-patch.ts`: File modification tool using unified diff format (create/update/delete files)
    -   `types.ts`: Shared tool type definitions
-   **UI Components** (`source/components/`):
    -   `MessageList.tsx`: Renders conversation history
    -   `LiveResponse.tsx`: Displays streaming agent responses with reasoning text in real-time
    -   `InputBox.tsx`: User text input field with slash command menu integration
    -   `SlashCommandMenu.tsx`: Interactive menu for slash commands
    -   `ApprovalPrompt.tsx`: Interactive y/n approval prompt for tool calls
    -   `ChatMessage.tsx`: Renders user, bot, system, and reasoning messages with markdown support
    -   `CommandMessage.tsx`: Displays executed shell commands and their output
    -   `MarkdownRenderer.tsx`: Terminal-based markdown renderer with support for headings, lists, code blocks, links, and inline formatting
    -   `TextInput.tsx`: Low-level text input component

### Architecture Pattern

The app uses a layered architecture for separation of concerns:

1. **UI Layer** (`app.tsx`, `components/`): Pure presentation, delegates all logic to hooks
2. **Hook Layer** (`hooks/`): Manages React state and coordinates with the service layer
    - `use-conversation.ts`: Conversation state, streaming, and approval flow
    - `use-slash-commands.ts`: Slash command menu and execution
    - `use-input-history.ts`: Input history navigation
3. **Service Layer** (`services/`): Business logic independent of React
    - `conversation-service.ts`: Agent runs, streaming responses, approval handling
    - `history-service.ts`: Persistent storage for input history
4. **Client Layer** (`openai-agent-client.ts`): Thin adapter around `@openai/agents` SDK for easy provider swapping
5. **Tool Layer** (`tools/`): Tool implementations with safety validation
    - Each tool follows the `ToolDefinition` interface with `needsApproval` and `execute` functions

### Agent Flow

The app uses the `@openai/agents` SDK with streaming responses and approval interruptions:

1. **User Input**: User sends a message via `sendUserMessage()` in the `useConversation` hook or executes a slash command
2. **Agent Stream**: Hook delegates to `ConversationService.sendMessage()` which calls `agentClient.startStream()`
3. **Real-time Streaming**:
    - Agent response streams back in real-time chunks
    - `LiveResponse` component displays both regular text and reasoning text as they stream
    - Reasoning text is extracted from `reasoning_item_created` events and displayed in dimmed gray color
    - Text and reasoning are tracked separately to maintain proper ordering
4. **Tool Execution with Approval**:
    - If the agent requests to use a tool (shell or apply_patch):
        - Service checks the `needsApproval` function in the tool definition
        - If approval needed, an interruption is returned
        - Any accumulated text and reasoning are flushed as separate messages
        - An `ApprovalMessage` is added to chat
        - UI displays approval prompt with command details (agent name, tool name, arguments)
    - User presses 'y' or 'n' to approve/reject
    - Hook calls `handleApprovalDecision()` → service continues the run with `state.approve()` or `state.reject()`
5. **Command Execution**:
    - Commands are emitted in real-time via `onCommandMessage` callback during streaming
    - Each command execution result is immediately displayed in the UI
    - Command IDs are tracked to prevent duplicates when extracting from run history
6. **Final Response**:
    - Service extracts any remaining command messages from run history
    - Hook updates UI with final bot response (if any additional text after commands)
    - Reasoning and text messages are kept separate in the conversation history

**Message Types**:

-   `UserMessage`: User input text
-   `BotMessage`: Agent response text (rendered with markdown)
-   `ReasoningMessage`: Agent reasoning output (displayed in gray, dimmed)
-   `ApprovalMessage`: Tool approval prompt with y/n answer
-   `CommandMessage`: Shell command execution with output
-   `SystemMessage`: System notifications (e.g., "Set model to gpt-4")

**Important**:

-   The `previousResponseId` is tracked to maintain conversation context across runs
-   Streaming is enabled with real-time text and reasoning output
-   Both `shell` and `apply_patch` tools have safety validation and approval logic
-   Commands can optionally skip approval by setting `needsApproval: false` if the agent determines they're safe (e.g., read-only commands)
-   Shell tool includes output trimming to prevent excessive output (configurable limits: 200 lines / 10KB by default)
-   Text and reasoning are flushed before command messages to maintain proper ordering: reasoning → text → commands → final response

## Common Commands

### Build

```bash
npm run build
```

Compiles TypeScript from `source/` to `dist/` using `tsc`.

### Development

```bash
npm run dev
```

Watch mode - auto-rebuilds on TypeScript file changes.

### Testing

```bash
npm test
```

Runs the full test suite: Prettier formatting check → XO linting → AVA tests.

To run individual test components:

```bash
npx prettier --check .
npx xo
npx ava
```

### Run the CLI

```bash
node dist/cli.js
```

## Development Notes

-   **TypeScript**: The project is fully TypeScript. All source files use `.ts` or `.tsx` extensions
-   **Testing**: AVA is configured to work with TypeScript via `@ava/typescript` package
-   **Linting**: Prettier for formatting (config from `@vdemedes/prettier-config`)
-   **Binary**: Distributed as `tt` command via npm bin field
-   **Agent Instructions**: External instruction file at `docs/agent-instructions.md` loaded into agent configuration
-   **Tools**:
    -   **Shell Tool** (`shell.ts`):
        -   Executes array of shell commands sequentially
        -   Safety validation via `validateCommandSafety()` and `isDangerousCommand()`
        -   Output trimming to prevent buffer overflow (configurable via `setTrimConfig()`)
        -   Agent can set `needsApproval: false` for safe read-only commands
    -   **Apply Patch Tool** (`apply-patch.ts`):
        -   Create, update, or delete files using unified diff format
        -   Uses `applyDiff()` from `@openai/agents` package
        -   Workspace path validation to prevent operations outside project root
        -   Always requires approval
-   **Utilities**:
    -   `extract-command-messages.ts`: Parses command execution results from agent run history
    -   `command-logger.ts`: Logging utilities for command validation
    -   `command-safety.ts`: Command safety validation logic
-   **State Management**:
    -   Input history persisted to XDG state directory using `env-paths` package
    -   Conversation context maintained via `previousResponseId` across agent runs
-   **UI Features**:
    -   Markdown rendering in terminal using `marked` library
    -   Slash command menu with autocomplete and fuzzy filtering
    -   Input history with up/down arrow navigation (max 1000 entries)
    -   Processing indicator with animated dots
    -   Color-coded message types (blue for user, gray for system/reasoning, colored markdown for bot)

## Reference

-   [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)
