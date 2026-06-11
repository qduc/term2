**Proposal**

Use a single public `run_subagent` tool, but make it a thin dispatcher that internally invokes a cached role-specific `Agent.asTool()` instance. That keeps the main-agent tool surface compact while still letting the SDK propagate nested approval interruptions through the outer tool call.

**Draft Plan**

- `source/tools/run-subagent.ts`
  - Keep the public tool name as `run_subagent`.
  - Change `role` from `z.string()` to a strict enum for the supported roles.
  - Keep the schema small and the description short so the parent agent does not carry role-specific prompt text.
  - Leave command-message formatting unchanged so UI output still shows `run_subagent [role] ...`.

- `source/services/subagents/subagent-manager.ts`
  - Extract the existing subagent construction logic into a reusable builder for a role-specific `Agent`.
  - Add an internal helper that wraps that agent with `agent.asTool(...)` for the selected role.
  - Cache the built role agents/tools so we do not rebuild prompt/tool definitions on every invocation.
  - Keep `SubagentManager.run()` for non-tool callers, but add a separate path used only by `run_subagent` that goes through the nested agent-tool execution path.

- `source/lib/agent-client.ts`
  - Replace the current `#runSubagent` path so it dispatches to the selected role’s internal `Agent.asTool()` instead of calling `SubagentManager.run()` directly.
  - Preserve the outer `toolCall`, `signal`, and `resumeState` when invoking the inner agent-tool so the SDK can associate nested results and approvals with the correct parent call.
  - Remove the “future work” comments once the nested path is real.

- `source/agent.ts` and `source/lib/agent-factory.ts`
  - Keep the parent agent exposing only one delegation tool.
  - Do not register per-role tools on the parent agent.
  - If needed, trim the public tool description/instructions so the role taxonomy is not repeated in multiple places.

- `source/services/conversation-result-builder.ts` and `source/services/approval-state.ts`
  - No major logic change expected, but verify the existing `nestedSubagent` flag is still set when a nested approval interruption comes back from the SDK.
  - Keep the approval event payload shape stable so the GUI can distinguish nested subagent approvals from normal tool approvals.

**Tests**

- `source/tools/run-subagent.test.ts`
  - Assert the public tool still exists as `run_subagent`.
  - Assert the role schema is strict and the formatter still renders the same command message shape.

- `source/services/subagents/subagent-manager.test.ts`
  - Add a regression test for a role-specific subagent tool that hits an approval-required inner tool and confirms the nested run metadata is preserved.
  - Add a test that the role agent/tool is cached or reused rather than rebuilt every call, if caching is part of the implementation.

- `source/services/conversation-result-builder.test.ts`
  - Add/extend a test that an approval interruption coming from a nested subagent is surfaced as `approval_required` with `nestedSubagent: true`.

- `source/agent.test.ts`
  - Keep the orchestrator/tool exposure test strict: the parent agent should still expose one delegation tool, not one per role.

**Acceptance Criteria**

- The main agent still sees one public delegation tool, not four role tools.
- A subagent tool call that requires approval surfaces to the parent as an approval interruption instead of being swallowed inside a blocking function tool.
- Approval continuation resumes the nested run correctly.
- Existing `run_subagent` command rendering and conversation logging remain stable.
- The parent prompt does not accumulate role-specific tool descriptions.

**Assumptions**

- Supported roles stay fixed to `explorer`, `worker`, `researcher`, and `mentor`.
- `ask_mentor` remains a separate path; it does not need the same nested approval plumbing because it has no workspace tool surface.
- The supported compromise is “one public tool, many internal role agents,” not “many public tools.”


# Feasibility Analysis: Nested Subagent Dispatcher (`Agent.asTool()`)

We analyzed the codebase and SDK internals (`@openai/agents-core`) to evaluate the proposal to route all role-specific subagents through a single public `run_subagent` tool, dispatching internally to cached `Agent.asTool()` instances.

---

## 1. Feasibility & Natively Supported Nested Approvals

The proposed plan is **fully doable** and aligns perfectly with the SDK design.

When the parent agent executes a tool registered via `Agent.asTool()`:
1. **Approval Interruption Propagation**: If a tool inside the subagent needs approval (e.g., the worker runs a yellow/red shell command), the nested runner throws an approval interruption. The SDK natively catches this and serializes the nested run state under the parent's `toolCall.callId` inside the parent's `_pendingAgentToolRuns` map, bubbling the interruption up to the parent run.
2. **Rehydration**: When the parent run is resumed, the dispatcher is executed again with the parent's `details`. The dispatcher calls `roleAgentTool.execute(params, context, details)`. The SDK's native `asTool.execute` checks `details.resumeState`, rehydrates the nested run using `RunState.fromStringWithContext`, and resumes the subagent execution from the exact point of interruption.

---

## 2. Key Architectural Risks & Mitigations

### ⚠️ Risk A: Closure State Leakage in Cached Subagent Tools
In the existing codebase, `filesChanged` (array) and `toolCounts` (map) are captured via local variables in the closure of `SubagentManager.#runSubagent` when tools are built.
* **The Problem**: If we build and cache the subagent `Agent` (which contains these tools), consecutive or concurrent subagent runs will mutate the *same* array and map. This leads to state pollution across runs.
* **The Solution**: Store `filesChanged` and `toolCounts` in a run-specific plain object (e.g., `subagentContext`) and pass it to the subagent execution context.
  ```typescript
  // In AgentClient or SubagentManager
  const subagentContext = {
    filesChanged: [] as string[],
    toolCounts: new Map<string, number>(),
    toolCallArgumentsById: new Map<string, unknown>(),
    emittedCommandIds: new Set<string>(),
    agentId: details?.toolCall?.callId ?? randomUUID(),
  };

  // Dispatch to the cached tool using subagentContext as the RunContext
  const outputText = await roleAgentTool.execute(params, subagentContext, details);
  ```
  Inside `buildAgentTools`, we update the `onToolStart` callback to receive the context:
  ```typescript
  onToolStart?: (toolName: string, params: unknown, commandMessages: CommandMessage[], context?: any) => void;
  ```
  And inside the subagent's tool definitions (`wrapShellTool`, `wrapWriteTool`), we extract the references dynamically:
  ```typescript
  const subagentContext = (context as any)?.context;
  const filesChanged = subagentContext?.filesChanged ?? [];
  ```

### ⚠️ Risk B: Subagent Event Logging and UI Streaming
Calling `roleAgentTool.execute(...)` runs the SDK runner directly, bypassing `ConversationSession`. Consequently, subagent events (`subagent_tool_started`, `subagent_command_message`) will not be generated automatically.
* **The Solution**: Register an `onStream` callback in the `AgentToolOptions` when caching the tool:
  ```typescript
  const roleAgentTool = agent.asTool({
    toolName: `run_subagent_${role}`,
    onStream: (streamEvent) => {
      // Map SDK RunItemStreamEvents to CLI subagent events
      handleNestedStreamEvent(streamEvent, subagentContext, emitEvent);
    }
  });
  ```
  * When `streamEvent.event.name === 'tool_called'`: Parse parameters and emit `subagent_tool_started`.
  * For all streaming items: Run them through `emitCommandMessagesFromItems(items, ...)` using the subagent's `toolCallArgumentsById` and emit `subagent_command_message`.

### ⚠️ Risk C: Cache Invalidation on Settings Changes
If the user updates model settings (e.g., changing `agent.subagentWorkerModel` or the global model), the cached subagents must be invalidated.
* **The Solution**: Expose a `clearCache()` method on `SubagentManager`. Call it from `AgentClient.#refreshAgent()` which already listens to settings changes.

---

## 3. Assembling the Subagent Result

Since `roleAgentTool.execute` returns a string (the summary), we can capture the final `CompletedAgentToolInvocationRunResult` object using `customOutputExtractor` in the `asTool` options:
```typescript
customOutputExtractor: (completedResult) => {
  subagentContext.completedResult = completedResult;
  return typeof completedResult.finalOutput !== 'undefined'
    ? String(completedResult.finalOutput)
    : '';
}
```
If the run succeeds, we can assemble the final `SubagentResult` object using the captured state:
```typescript
return {
  agentId: subagentContext.agentId,
  role: params.role,
  status: 'completed',
  finalText: subagentContext.completedResult?.finalOutput ?? '',
  filesChanged: [...new Set(subagentContext.filesChanged)],
  toolsUsed: aggregateToolUsage(subagentContext.toolCounts),
  usage: extractUsage(subagentContext.completedResult),
};
```
If the run fails or is cancelled, we catch the thrown error, parse the aborted/failed state, and return a structured failed/cancelled `SubagentResult` to keep UI outputs stable.
