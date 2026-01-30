# Integration Plan: GitHub Copilot Model Provider

This document outlines the plan to integrate the official **GitHub Copilot SDK** (`@github/copilot-sdk`) as a model provider for this project.

> [!NOTE]
> API verified against SDK documentation on 2026-01-29. SDK is in Technical Preview.

## Overview
The GitHub Copilot SDK allows programmatic access to the GitHub Copilot Agent core. It communicates with the `copilot` CLI via JSON-RPC. The SDK manages CLI process lifecycle automatically.

## Prerequisites
- **GitHub Copilot CLI** installed and authenticated (`gh auth login`)
- A valid **GitHub Copilot subscription**

> [!NOTE]
> **SSH/Remote Compatibility**: This provider is fully compatible with SSH/Remote sessions. The **GitHub Copilot SDK and CLI run locally** on the host machine. The application's existing command execution layer handles routing shell commands to the appropriate remote environment (SSH). No installation is required on the remote server.

## Proposed Architecture

### 1. Dependencies
```bash
npm install @github/copilot-sdk zod
```
- `zod` is recommended for type-safe tool definitions

### 2. New Provider Structure
Follow the existing provider pattern in `source/providers/github-copilot/`:

| File | Purpose |
|------|---------|
| `github-copilot.provider.ts` | Registry entry point |
| `provider.ts` | Implements `ModelProvider` interface |
| `model.ts` | Handles completions and streaming |
| `converters.ts` | Maps `ModelRequest`/`ModelResponse` to SDK types |

### 3. Core Implementation Strategy

#### Client & Session Lifecycle
```typescript
import { CopilotClient } from "@github/copilot-sdk";

// Singleton client (SDK manages CLI process automatically)
const client = new CopilotClient();

// Per-request session
const session = await client.createSession({
    model: "gpt-4o",
    streaming: true,
});
```

#### Streaming Implementation
Map SDK events to project's `ResponseStreamEvent`:

```typescript
session.on((event) => {
    switch (event.type) {
        case "assistant.message_delta":
            // Streaming text chunk
            emit({ type: "text_delta", content: event.data.deltaContent });
            break;
        case "assistant.reasoning_delta":
            // Streaming reasoning (O1/O3 models)
            emit({ type: "reasoning_delta", content: event.data.deltaContent });
            break;
        case "tool.execution_start":
            // Tool call requested
            emit({ type: "tool_call", name: event.data.toolName, args: event.data.args });
            break;
        case "session.idle":
            // Session complete
            emit({ type: "done" });
            break;
        case "session.error":
            // Handle errors
            emit({ type: "error", message: event.data.message });
            break;
    }
});
```

#### Tool Approval Strategy

> [!IMPORTANT]
> By default, SDK enables `--allow-all` mode. We must disable default tools and register our own with approval interception.

```typescript
import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";

// Wrap existing tools with approval flow
const shellTool = defineTool("shell", {
    description: "Execute a shell command",
    parameters: z.object({
        command: z.string().describe("Command to execute"),
    }),
    handler: async ({ command }) => {
        // Intercept and request approval via existing flow
        const approved = await requestApproval("shell", { command });
        if (!approved) {
            return { resultType: "rejected", textResultForLlm: "User rejected command" };
        }
        // Execute via existing tool implementation
        return executeShellCommand(command);
    },
});

const session = await client.createSession({
    model: "gpt-4o",
    tools: [shellTool, applyPatchTool, grepTool /* ... */],
    // Disable default tools to maintain approval flow
});
```

### 4. Model List Fetching
SDK exposes available models at runtime:
```typescript
const models = await client.getAvailableModels();
// Returns: ["gpt-4o", "claude-3.5-sonnet", "gpt-5", ...]
```

### 5. Error Handling
```typescript
try {
    await session.send({ prompt });
} catch (error) {
    await client.forceStop(); // Cleanup on error
    throw error;
}

// Or via session abort
await session.abort(); // Cancel in-flight request
```

### 6. Settings Integration
Add to `SettingsService`:
- `agent.provider`: Add `"github-copilot"` option
- `agent.github-copilot.model`: Model selection (default: `gpt-4o`)

## Implementation Steps

### Phase 1: Foundation
- [ ] Install `@github/copilot-sdk` and `zod`
- [ ] Create file structure in `source/providers/github-copilot/`
- [ ] Implement `registerProvider` boilerplate
- [ ] Add environment validation (verify local `gh copilot` availability)

### Phase 2: Streaming
- [ ] Implement `GitHubCopilotModel.getStreamedResponse`
- [ ] Map `assistant.message_delta` → `ResponseStreamEvent`
- [ ] Map `assistant.reasoning_delta` → reasoning channel
- [ ] Handle `session.idle` and `session.error`

### Phase 3: Tool Integration
- [ ] Wrap existing tools with `defineTool()` and approval handlers
- [ ] Ensure tool results flow back correctly
- [ ] Test with shell, apply-patch, grep tools

### Phase 4: Validation
- [ ] Write unit tests (TDD per AGENTS.md)
- [ ] Add regression tests for tool call parsing
- [ ] Test model switching
- [ ] Test error scenarios (CLI not installed, auth failure)

## Rationale
Using the official SDK is preferred because:
- Handles JSON-RPC communication with CLI automatically
- Manages authentication and token refreshes
- Manages CLI process lifecycle (no manual spawning)
- Provides standardized access to GitHub's multi-model routing
