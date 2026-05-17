# Worker Subagents Specification

## Overview

Extend the current mentor-mode implementation into worker-style subagents that can inspect the workspace, run a scoped set of tools, optionally edit files, and return structured results to the parent agent.

The existing mentor system is a useful starting point, but it is advisory only:

- `ask_mentor` sends a question to a secondary model.
- The secondary model has its own model/provider/reasoning settings.
- The secondary model has no tools and no direct workspace access.
- The parent agent must manually pass all relevant context.

Worker subagents need a stronger execution model: independent agent sessions, explicit tool scopes, approval routing, edit isolation, lifecycle events, and structured result reporting.

## Goals

- Let the parent agent delegate bounded work to specialized subagents.
- Support read-only explorer/mentor/researcher subagents and edit-capable worker subagents.
- Keep subagent permissions explicit and auditable.
- Reuse existing provider, runner, tool, approval, logging, and conversation infrastructure where practical.
- Preserve user control over risky operations such as shell commands and file writes.
- Make subagent activity visible in the terminal UI.
- Return structured results that the parent can reason over.

## Non-Goals

- Do not initially implement fully autonomous background agents that continue after the user session exits.
- Do not give subagents unrestricted tool access by default.
- Do not require parallel execution for the first implementation.
- Do not make subagents a replacement for the main conversation session.
- Do not silently apply unscoped edits from workers.

## Current Implementation Baseline

Relevant files:

| File | Current role |
| --- | --- |
| `source/tools/ask-mentor.ts` | Defines the `ask_mentor` tool and display formatting. |
| `source/lib/openai-agent-client.ts` | Contains `MentorSession` and `#createMentor`. |
| `source/agent.ts` | Adds `ask_mentor` when `agent.mentorModel` is configured and appends `mentor-addon.md` in mentor mode. |
| `source/prompts/mentor-addon.md` | Main-agent guidance for consulting the mentor. |
| `source/services/conversation-session.ts` | Owns the foreground stream, previous response id, approval state, and continuation flow. |
| `source/services/approval-flow-coordinator.ts` | Manages one pending approval for the foreground session. |
| `source/services/conversation-events.ts` | Defines stream events consumed by the UI. |
| `source/tools/types.ts` | Defines `ToolDefinition` and `CommandMessage`. |

The main gap is that `MentorSession` is a single-purpose private helper. It should become a reusable subagent session abstraction.

## Subagent Types

Initial built-in roles:

| Role | Tool scope | Expected use |
| --- | --- | --- |
| `explorer` | read-only workspace tools | Locate relevant files, summarize structure, answer codebase questions. |
| `worker` | scoped read/write tools | Implement a bounded change in assigned files or directories. |
| `researcher` | web tools, optionally read-only workspace tools | Look up external docs or current information. |
| `mentor` | read-only advisory tools, or no tools initially | Backward-compatible preset for the existing `ask_mentor` behavior. |

The role controls default instructions and default tool scope. A parent tool call may further restrict the scope, but should not broaden beyond the role definition.

## User-Facing Tool API

### MVP: Synchronous `run_subagent`

Start with one blocking tool. The parent agent calls it and waits for completion.

```typescript
run_subagent({
  role: 'explorer' | 'worker' | 'researcher' | 'mentor' | string,
  task: string,
  writeBoundary?: string[],
})
```

Behavior:

- Creates a subagent session.
- Builds a scoped tool set.
- Runs the subagent to completion or until approval is needed.
- Streams or records subagent activity.
- Returns a structured result to the parent agent.

### Later: Async Lifecycle Tools

Once the synchronous version works, split lifecycle control into separate tools:

```typescript
spawn_subagent({ role, task, writeBoundary })
wait_subagent({ agentId, timeoutMs? })
send_subagent({ agentId, message })
abort_subagent({ agentId })
```

This enables parallel workers, but it requires UI and approval support for multiple active subagent sessions.

## Structured Result Contract

```typescript
export interface SubagentResult {
  agentId: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string;
  filesChanged: string[];
  toolsUsed: Array<{
    toolName: string;
    count: number;
  }>;
  usage?: NormalizedUsage;
  error?: string;
}
```

`task` is the full prompt passed from the parent to the subagent. It should include any relevant context, constraints, and expected output format.

`finalText` is the subagent's final answer only. It must exclude intermediate assistant text emitted before or between tool calls, reasoning summaries, and tool transcripts. If the subagent used tools, `finalText` should be taken from the assistant output after the last tool result/tool-call continuation. This prevents in-progress narration from polluting the parent agent context.

`SubagentResult` should stay compact because it is returned to the parent agent and may enter the parent model context. It should not include every tool call transcript. Detailed tool activity belongs in real-time subagent events for the UI/logging layer.

## Architecture

### New Core Types

Add `source/services/subagents/types.ts`:

```typescript
export type SubagentRole = 'explorer' | 'worker' | 'researcher' | 'mentor' | string;

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  writeBoundary?: string[];
}

export interface SubagentDefinition {
  role: SubagentRole;
  name: string;
  instructions: string;
  canRead: boolean;
  canWrite: boolean;
  canSearchWeb: boolean;
  canRunShell: boolean;
}
```

### Subagent Manager

Add `source/services/subagents/subagent-manager.ts`.

Responsibilities:

- Create and track subagent sessions.
- Resolve role definitions.
- Build scoped tool definitions.
- Create `Agent` instances with the selected provider/model/reasoning settings.
- Run subagents through the provider runner.
- Collect final output, tool activity metadata, files changed, and usage.
- Route cancellation and approval state.

Suggested interface:

```typescript
export class SubagentManager {
  run(request: SubagentRequest): Promise<SubagentResult>;
  spawn(request: SubagentRequest): Promise<{ agentId: string }>;
  wait(agentId: string, options?: { timeoutMs?: number }): Promise<SubagentResult>;
  abort(agentId: string): Promise<void>;
}
```

### Subagent Session

Replace the private `MentorSession` shape with a general session class:

```typescript
class SubagentSession {
  id: string;
  role: string;
  provider: string;
  runner: Runner | null;
  agent: Agent;
  store: ConversationStore;
  previousResponseId: string | null;
  abortController: AbortController | null;
}
```

Each subagent session owns its own `ConversationStore` and `previousResponseId`. Histories must not be shared between subagents or with the parent.

## Provider Run Mode

Subagent provider calls should default to non-streaming runs:

```typescript
{
  stream: false,
  maxTurns: request.maxTurns ?? roleDefaultMaxTurns
}
```

The UI does not need to render subagent model text token-by-token. The subagent's final written response is returned through `SubagentResult.finalText` after completion.

When extracting `finalText`, discard assistant text that occurred before the final tool-call cycle completed. Only the final assistant message after the last tool result should be returned to the parent. If the run completed without tool calls, use the final assistant output normally.

Real-time UI updates for tools should not depend on model text streaming. Instead, the subagent tool wrapper should emit lifecycle events before and after each tool executes:

- `subagent_tool_started`
- `subagent_command_message`

Use streaming subagent runs only if a future UI explicitly wants live subagent text or if an SDK/provider limitation requires streaming to surface approval interruptions correctly.

## Tool Scoping

Subagent tools should be constructed from existing tool factories, but filtered and wrapped by a subagent policy.

Role frontmatter should describe capabilities, not concrete tool names. The manager maps capabilities to the current concrete tools:

| Capability | Concrete tools |
| --- | --- |
| `canRead` | `read_file`, `grep`, `find_files`, `read_code_outline`, `code_context_search` |
| `canWrite` | `apply_patch`, `search_replace`, `create_file` |
| `canSearchWeb` | `web_search`, `web_fetch` |
| `canRunShell` | `shell` |

This keeps role definitions stable if the tool implementation changes.

### Read-Only Tools

Useful for `explorer`, `mentor`, and optionally `researcher`:

- `read_file`
- `grep`
- `find_files`
- `read_code_outline`
- `code_context_search`
- `web_search`
- `web_fetch`

### Edit Tools

Only for `worker`, and only inside the allowed workspace/write boundary:

- `apply_patch`
- `search_replace`
- `create_file`

The write policy should reject edits outside the workspace and outside any explicit `writeBoundary` before the underlying tool runs. `writeBoundary` is a permission boundary, not a concurrency contract.

### Shell Tool

Follow the same shell approval policy as the main agent, but only for roles whose definitions explicitly allow shell access.

Default shell policy by role:

| Role | Shell access |
| --- | --- |
| `explorer` | No shell by default. |
| `worker` | No shell by default. Workers edit through scoped edit tools. |
| `researcher` | No shell by default. |
| `mentor` | No shell. |

Custom role definitions may enable shell access. Shell-capable subagents may use the same shell auto-approval policy as the main agent.

## Approval Model

The current approval flow assumes one foreground pending approval. Worker subagents need a routing decision.

### MVP: Foreground Blocking Approval

For the first implementation:

- `run_subagent` blocks the parent while the subagent runs.
- If the subagent needs approval, surface the approval as the active foreground approval.
- Include `agentId`, `role`, and subagent name in the approval descriptor.
- Continue the subagent after approval/rejection.
- Return control to the parent only after the subagent completes or fails.

This avoids supporting multiple simultaneous pending approvals.

### Later: Nested Approval Channels

For async/parallel subagents, add approval routing:

```typescript
export interface ApprovalDescriptor {
  agentName: string;
  agentId?: string;
  parentAgentId?: string;
  toolName: string;
  argumentsText: string;
  rawInterruption: unknown;
  callId?: string;
}
```

The UI then needs to show which subagent is asking and route the decision back to the correct session.

## Edit Isolation

Subagents can conflict with the parent agent or with each other. Directory-level scopes are too coarse to solve this: real tasks often span multiple folders, and two workers may touch different files inside overlapping folders without actually conflicting.

Use two separate concepts:

- `writeBoundary`: optional permission boundary that limits where a worker may write. Defaults to the workspace root for edit-capable workers.
- File claim/lock: dynamic, concrete file-level ownership acquired immediately before a write operation.

Minimum safe policy:

- Edit tools must verify target paths are inside the workspace and any explicit `writeBoundary`.
- Edit tools must acquire a file-level lock before modifying a file.
- If another session already holds the file lock, the write is rejected with a conflict result instead of waiting indefinitely.
- Workers may touch files across multiple folders as long as each file passes the boundary check and lock acquisition.
- The parent prompt should tell workers not to revert changes made by others.
- Worker final output and `SubagentResult.filesChanged` must list changed files.

For async/parallel workers, the parent should still try to assign non-overlapping responsibilities, but correctness should rely on file-level conflict detection, not folder-level disjointness.

Potential later improvement: run each worker in a separate git worktree or branch and merge patches after review. That is safer for parallel edits but heavier to implement.

## Conversation Events

Add subagent-aware events in `source/services/conversation-events.ts`:

```typescript
export interface SubagentStartedEvent {
  type: 'subagent_started';
  agentId: string;
  role: string;
  task: string;
}

export interface SubagentToolStartedEvent {
  type: 'subagent_tool_started';
  agentId: string;
  role: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export interface SubagentCommandMessageEvent {
  type: 'subagent_command_message';
  agentId: string;
  role: string;
  message: CommandMessage;
}

export interface SubagentCompletedEvent {
  type: 'subagent_completed';
  result: SubagentResult;
}
```

Subagent tool activity should be emitted in real time through events such as `subagent_tool_started` and `subagent_command_message`. The terminal UI can render these as nested or collapsible subagent activity without waiting for the final result.

The parent agent should receive only the compact `SubagentResult`, not the full event stream. If the parent needs details, the subagent should include only task-relevant conclusions in the final post-tool `finalText`.

## Role Definitions

Do not add a new persistent subagent settings tree for the initial implementation. Most subagent behavior should live in role definition markdown files with frontmatter, for example `source/prompts/subagents/worker.md`.

Example:

```markdown
---
name: Worker
model: inherit
provider: inherit
reasoningEffort: inherit
canRead: true
canWrite: true
canSearchWeb: false
canRunShell: false
maxTurns: 20
---

You are a worker subagent...
```

Resolution rules:

Recommended precedence, highest to lowest:

1. Runtime request restrictions, such as `writeBoundary`, may only narrow permissions.
2. Role markdown frontmatter defines model/provider/reasoning, capability booleans, and max turns.
3. Main agent settings are inherited when a frontmatter value is `inherit` or omitted.

Frontmatter can define maximum permissions, but task-specific write boundaries should come from the parent request when narrower boundaries are known. Actual overlap between workers should be handled through file-level locks and changed-file reporting, because folder boundaries are often too imprecise.

Compatibility path:

- Keep `agent.mentorModel`, `agent.mentorProvider`, and `agent.mentorReasoningEffort`.
- Implement `ask_mentor` as a thin alias over `run_subagent({ role: 'mentor', ... })`.
- Keep `/mentor` behavior initially, but internally route through the subagent infrastructure.

The existing mentor settings are a compatibility bridge, not a pattern for adding new subagent settings. New roles should be configured through role markdown files.

## Prompting

Add role prompt files under `source/prompts/subagents/`:

```text
source/prompts/subagents/explorer.md
source/prompts/subagents/worker.md
source/prompts/subagents/researcher.md
source/prompts/subagents/mentor.md
```

Every subagent prompt should include:

- Role and boundaries.
- Available tools.
- Explicit task.
- Context supplied by the parent.
- Workspace/write boundary.
- Final report format.
- Instruction not to assume access to hidden parent reasoning.
- Instruction not to revert unrelated or external changes.

Worker prompt requirements:

- Read relevant files before editing.
- Keep edits limited to assigned scope.
- Do not broaden the task.
- Report every changed file.
- Run only requested or allowed checks.

## Implementation Plan

### Phase 1: Rename and Generalize Mentor Internals

- Extract `MentorSession` into `SubagentSession`.
- Add `SubagentManager` with one synchronous `run` method.
- Preserve existing `ask_mentor` behavior through the new manager.
- Add regression tests proving `ask_mentor` still uses the configured mentor model/provider and preserves session isolation.

### Phase 2: Add Read-Only Subagents

- Add `run_subagent` tool.
- Support `explorer` and `researcher`.
- Give them only read-only and/or web tools.
- Return `SubagentResult`.
- Emit real-time subagent events for tool activity.
- Keep the final `SubagentResult` compact so it does not bloat parent context.

### Phase 3: Add Edit-Capable Worker

- Add `worker` role.
- Allow direct edits inside the workspace and any explicit `writeBoundary`.
- Wrap edit tools with workspace/boundary validation.
- Acquire file-level locks before each write.
- Track changed files and return them in `SubagentResult.filesChanged`.
- Use file locks around edit operations.
- Add tests for allowed and rejected write paths.

### Phase 4: Async and Parallel Subagents (postponed)

- Add `spawn_subagent`, `wait_subagent`, `send_subagent`, and `abort_subagent`.
- Add `maxConcurrent`.
- Prevent simultaneous writes to the same file through file locks.
- Report file conflicts back to the parent so it can retry, serialize, or reassign work.
- Add subagent lifecycle UI events.

## Testing Strategy

Follow TDD for each phase.

High-value test cases:

- `run_subagent` rejects unknown roles when custom roles are disabled.
- Subagent receives only tools allowed by role and request.
- Read-only roles cannot access edit tools.
- Worker edit outside the workspace or explicit `writeBoundary` is rejected before the tool executes.
- Concurrent writes to the same file are rejected through file locks.
- Changed files are reported in `SubagentResult.filesChanged`.
- Subagent history is isolated between sessions.
- Provider/model changes do not leak old subagent state.
- `ask_mentor` remains backward compatible.
- Subagent approval descriptors include `agentId` and role.
- Parent session resumes after a subagent completes.
- Parallel workers cannot write the same file concurrently. (phase 4)

Focused test locations:

- `source/tools/run-subagent.test.ts`
- `source/services/subagents/subagent-manager.test.ts`
- `source/services/subagents/subagent-session.test.ts`
- `source/lib/openai-agent-client.public-methods.test.ts`
- `source/services/conversation-result-builder.test.ts`
- `source/services/conversation-events.ts` type coverage through consumers

## Open Decisions

- Whether the first edit worker should apply patches directly or return patch proposals for the parent to apply. -> directly
- Whether subagents should use the main model by default or require an explicit subagent setting. -> no new setting. Each subagent has a markdown role definition with frontmatter. Model/provider/reasoning default to `inherit` when omitted.
- Whether `/mentor` should remain a distinct mode or become a preset over subagents. -> `/mentor` will be a `mentor` preset subagent.
- Whether async subagents should be visible as collapsible nested UI output or summarized as command messages until completion. -> keep it simple for now.
- Whether shell-capable subagents should be allowed to use the shell auto-approval policy by default. -> yes, but only for roles that explicitly allow shell.
- Whether parallel workers should require disjoint write boundaries up front. -> no. The main agent should assign non-overlapping responsibilities when possible, but enforcement should happen through file-level locks and conflict reporting. (phase 4)

## Recommended MVP

Build the synchronous path first:

1. Generalize `MentorSession` into `SubagentSession`.
2. Add `SubagentManager.run`.
3. Reimplement `ask_mentor` on top of `SubagentManager`.
4. Add `run_subagent` for read-only `explorer`, `researcher`, and `mentor`.
5. Add `worker` only after workspace/boundary validation, file locking, and changed-file reporting are in place.

This delivers useful worker delegation without forcing the UI and approval system to handle multiple active agents immediately.
