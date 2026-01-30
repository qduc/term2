# Deep Dive: GitHub Copilot SDK vs. OpenAI Agents SDK Tool Conflict

This document outlines the architectural mismatch discovered during the implementation of the GitHub Copilot provider, specifically regarding how tools are managed and executed.

## The Problem Statement

Our application uses the **OpenAI Agents SDK** as its core orchestration layer. This SDK expects to own the "control loop":
1. Model requests a tool call.
2. The Runner pauses and yields control to the application.
3. The application handles UI (approval prompts, logging).
4. The tool is executed.
5. The result is fed back to the model manually.

The **GitHub Copilot SDK** (`@github/copilot-sdk`) is designed as a **managed runtime**. It expects to own the entire turn:
1. You register tools *with implementations* (handlers) at session startup.
2. The model requests a tool.
3. The SDK **automatically calls your handler**.
4. The SDK **automatically sends the result back** to the model and continues the conversation.

## Current Technical Hurdles

### 1. Visibility & Capabilities
In the current implementation, `GitHubCopilotModel` creates a session without registering tools:
```typescript
session = await client.createSession({ model: modelId, streaming: true });
```
Because no tools are provided to the Copilot SDK, the underlying model is told it has no tools available. Consequently, it never attempts to call our `shell`, `apply_patch`, or `grep` tools, even if the `OpenAIAgentClient` includes them in its prompt or request object.

### 2. Approval Flow Conflict
Our application requires manual user approval for almost all tools.
- The Copilot SDK's `handler` is an `async` function.
- If we put the approval logic inside the `handler`, the Copilot stream "hangs" until the user answers in the terminal.
- However, our UI (Ink) expects the stream to "finish" or "interrupt" so it can render the `ApprovalPrompt` component.
- This creates a deadlock: the UI can't show the prompt until the stream stops, but the stream won't stop (or emit a "done" signal) until the handler returns.

### 3. Tool Result Injection
The Copilot SDK does not (currently) expose a way to "manually" inject a tool result after the fact. It expects the cycle: `Request -> Handler -> Result -> Continuation` to happen atomically within the `session.send()` call.

## Solution: The "Detached Handler" Pattern (Implemented 2026-01-30)

We have successfully resolved the conflict by implementing a **"Detached Handler"** pattern (also known as "Trap & Resume") directly in the `GitHubCopilotModel` adapter.

### Mechanism

1.  **Trap:** We register all user tools with a special wrapper handler. When the Copilot SDK invokes this handler, instead of executing the tool, we return a `new Promise` that **never resolves immediately**. This effectively freezes the Copilot session in the "Executing Tool" state.
2.  **Signal:** Simultaneously, we intercept the `tool.execution_start` event in the main `getStreamedResponse` loop. When we detect a user tool call, we:
    *   Yield a `function_call` event to the Agent Runner.
    *   Emit a `response_done` event containing the current `responseId` (mapped to the session ID).
    *   **Break the loop** and return from the generator. This tells the Runner that the "Model Generation" phase is complete and it should now handle the tool execution.
3.  **Resume:** When the Runner calls the model again with the tool output (providing the `previousResponseId`):
    *   We look up the frozen session using the ID.
    *   We locate the pending `Promise` for the specific tool call.
    *   We **resolve** the promise with the tool output provided by the Runner.
    *   This unblocks the Copilot SDK's background loop, allowing it to process the tool result and continue generating the response (which we stream back to the Runner).

This approach bridges the gap between the Agents SDK's "Request-Response" model and Copilot's "Managed Runtime" without requiring changes to either SDK's core logic.

## Summary of History Fix (2026-01-30)
Turn-by-turn history was successfully fixed by mapping the app's `previousResponseId` to the SDK's `sessionId` and using `client.resumeSession()`. However, this only applies to text-only conversations until the tool conflict is resolved.
