# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## Project Overview

This is a terminal-based AI assistant application built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js. The application provides an interactive CLI where users can chat with an AI agent that can execute bash commands with user approval.

## Architecture

The codebase follows a clean separation of concerns pattern with distinct layers:

### Key Components

-   **CLI Entry Point** (`source/cli.tsx`): Minimal entry point that renders the Ink React app
-   **Main App** (`source/app.tsx`): React component orchestrating the UI, delegating conversation logic to the `useConversation` hook
-   **Agent Definition** (`source/agent.ts`): Configures the OpenAI agent with the bash tool
-   **Conversation Hook** (`source/hooks/use-conversation.ts`): Custom React hook managing conversation state, messages, and approval flow
-   **Conversation Service** (`source/services/conversation-service.ts`): Business logic layer handling agent runs, streaming responses, and approval decisions
-   **OpenAI Agent Client** (`source/lib/openai-agent-client.ts`): Minimal adapter isolating usage of `@openai/agents` SDK
-   **Bash Tool** (`source/tools/bash.ts`): Tool definition with safety validation and approval logic
-   **UI Components** (`source/components/`):
    -   `MessageList.tsx`: Renders conversation history
    -   `LiveResponse.tsx`: Displays streaming agent responses in real-time
    -   `InputBox.tsx`: User text input field
    -   `ApprovalPrompt.tsx`: Interactive y/n approval prompt for tool calls
    -   `ChatMessage.tsx`: Renders user and bot messages
    -   `CommandMessage.tsx`: Displays executed bash commands and their output

### Architecture Pattern

The app uses a layered architecture for separation of concerns:

1. **UI Layer** (`app.tsx`, `components/`): Pure presentation, delegates all logic to hooks
2. **Hook Layer** (`use-conversation.ts`): Manages React state and coordinates with the service layer
3. **Service Layer** (`conversation-service.ts`): Business logic for conversation flow, approval handling, and streaming
4. **Client Layer** (`openai-agent-client.ts`): Thin adapter around `@openai/agents` SDK for easy provider swapping
5. **Tool Layer** (`tools/bash.ts`): Tool implementations with safety validation

### Agent Flow

The app uses the `@openai/agents` SDK with streaming responses and approval interruptions:

1. User sends a message via `sendUserMessage()` in the hook
2. Hook delegates to `ConversationService.sendMessage()` which calls `agentClient.startStream()`
3. Agent response streams back in real-time chunks, displayed via `LiveResponse` component
4. If the agent requests to use the bash tool:
    - Service checks the `needsApproval` function in the tool definition
    - If approval needed, an interruption is returned and an `ApprovalMessage` is added to chat
    - UI displays approval prompt with command details (agent name, tool name, command)
    - User presses 'y' or 'n' to approve/reject
    - Hook calls `handleApprovalDecision()` → service continues the run with `state.approve()` or `state.reject()`
5. After approval (or if no approval needed), the tool executes and returns results
6. Service extracts command messages from run history and final response text
7. Hook updates UI with command messages (showing executed commands and output) and final bot response

**Important**:

-   The `previousResponseId` is tracked to maintain conversation context across runs
-   Streaming is enabled via `stream: true` in the run options
-   The bash tool has built-in safety validation (`validateCommandSafety`) and dangerous command blocking
-   Commands can optionally skip approval by setting `needsApproval: false` parameter if the agent determines they're safe

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

-   **TypeScript**: The project has been migrated to TypeScript. All source files use `.ts` or `.tsx` extensions
-   **Testing**: AVA is configured to work with TypeScript via `@ava/typescript` package
-   **Linting**: XO linter is configured with `xo-react` and has `react/prop-types` disabled (TypeScript handles type checking)
-   **Prettier**: Formatting config is imported from `@vdemedes/prettier-config`
-   **Command Safety**: The bash tool includes:
    -   `validateCommandSafety()`: Checks if commands modify system state or access sensitive data
    -   `isDangerousCommand()`: Blocks explicitly dangerous commands (rm -rf, dd, etc.)
    -   Agent can set `needsApproval: false` for safe read-only commands to skip user approval
-   **Utilities**:
    -   `extract-command-messages.ts`: Parses command execution results from agent run history
    -   `command-logger.ts`: Logging utilities for command validation
    -   `command-safety.ts`: Command safety validation logic

## Reference

-   [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)
