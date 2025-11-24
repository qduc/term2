# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## Project Overview

This is a terminal-based AI assistant application built with React (Ink), OpenAI Agents SDK, and Node.js. The application provides an interactive CLI where users can chat with an AI agent that can execute bash commands with user approval.

## Architecture

### Key Components

- **CLI Entry Point** (`source/cli.js`): Minimal entry point that renders the Ink React app
- **Main App** (`source/app.js`): React component managing the chat interface, conversation state, and agent interaction flow
- **Agent Definition** (`source/agent.js`): Configures the OpenAI agent with a bash tool that requires approval before execution

### Agent Flow

The app uses the `@openai/agents` SDK with a server-managed conversation pattern:

1. Conversation is initialized on mount via `client.conversations.create()`
2. User messages trigger `run(agent, userMessage, { conversationId })`
3. When the agent wants to use the bash tool, an interruption occurs requiring approval
4. The UI displays the interruption details (agent name, tool name, arguments) in a yellow-bordered box
5. User approves/rejects with "y" or any other key
6. Run continues with `run(agent, currentRunResult.state)` until completion

**Important**: The conversation ID is managed by OpenAI's servers and persists context across runs. The `processRunResult` function handles the approval loop recursively.

## Common Commands

### Build
```bash
npm run build
```
Transpiles React JSX from `source/` to `dist/` using Babel.

### Development
```bash
npm run dev
```
Watch mode - auto-rebuilds on file changes.

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

- Tests use `import-jsx` loader for JSX support (configured in package.json ava.nodeArguments)
- The test file (`test.js`) is outdated and doesn't match the current app implementation
- XO linter is configured with `xo-react` and has `react/prop-types` disabled
- Prettier config is imported from `@vdemedes/prettier-config`
- All bash commands executed by the agent require user approval (enforced by `needsApproval: async () => true`)

## Reference

- [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)
