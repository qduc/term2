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

-   **Entry Points**: `source/cli.tsx` (entry), `source/app.tsx` (main React component)
-   **State & Logic**:
    -   `source/hooks/` - UI state (conversation, slash commands, input history)
    -   `source/services/` - Business logic (conversation flow, approval, logging)
-   **Agent & Tools**:
    -   `source/agent.ts` - Agent configuration
    -   `source/lib/openai-agent-client.ts` - Agent client with tool interceptor pattern
    -   `source/providers/` - Pluggable provider registry (OpenAI, OpenRouter)
    -   `source/tools/` - Tool implementations (shell, search-replace, grep, apply-patch)
-   **UI**: `source/components/` - React Ink components for terminal rendering
-   **Docs**: `docs/agent-instructions.md`, `tsconfig.json`, `package.json`

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

- Pluggable provider registry with dependency-injected runner creation. Providers (e.g. OpenAI, OpenRouter) register via `source/providers` and may expose a `createRunner(deps)` factory so runners can be constructed without circular imports.
- Provider-neutral conversation strategy: a client-side `ConversationStore` is used where providers don't manage server-side state; when supported we pass `previousResponseId` to OpenAI to enable server-side chaining.
- Tool interceptor and approval model: tools (shell, apply-patch, search-replace, grep) run through centralized validation and an approval flow; utilities provide safe diff generation and output sanitization.
- Dependency injection and testability: services accept interfaces (logging, settings) and a `SettingsService` mock exists to simplify unit tests and avoid I/O in tests.
- Session & streaming model: conversation sessions stream deltas, capture reasoning, and surface tool calls for explicit approval; retry and failure-tracking behavior is configurable.

For implementation details, chronological change logs, and rationale, consult the source files under `source/` and the Git history — this document intentionally stays at a high level.

## Testing & Quality

This project follows TDD approach. You MUST write tests first and then write the minimum code to pass them.

```bash
npm test              # Run all tests
npx prettier --check . # Format check
npx ava               # Unit tests
```

## Key Concepts

-   **Tool Interceptors**: Centralized validation and approval flow for all tools
-   **Tool Approval**: Tools validate operations before execution; valid requests pause for user approval
-   **Failure Tracking**: Consecutive tool failures trigger automatic abort after threshold (default: 3)
-   **Streaming**: Responses and reasoning stream in real-time
-   **Provider Registry**: Pluggable provider support (OpenAI, OpenRouter) with dependency injection
-   **Conversation Store**: Client-side history for providers without server-side state management

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
