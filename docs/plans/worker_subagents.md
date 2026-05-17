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
- Support read-only explorer/reviewer subagents and edit-capable worker subagents.
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

The role controls default instructions and default tool scope. A parent tool call may further restrict the scope, but should not broaden beyond the role default unless explicitly allowed by settings.

## User-Facing Tool API

### MVP: Synchronous `run_subagent`

Start with one blocking tool. The parent agent calls it and waits for completion.

```typescript
run_subagent({
  role: 'explorer' | 'worker' | 'researcher' | string,
  task: string,
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
spawn_subagent({ role, task, context, allowedTools, writeScope })
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
  usage?: NormalizedUsage;
  error?: string;
}
```

## Architecture

### New Core Types

Add `source/services/subagents/types.ts`:

```typescript
export type SubagentRole = 'explorer' | 'worker' | 'researcher' | string;

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
}

export interface SubagentDefinition {
  role: SubagentRole;
  name: string;
  instructions: string;
  defaultAllowedTools: string[];
  canWrite: boolean;
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
- Collect stream output, command messages, files changed, and usage.
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

## Tool Scoping

Subagent tools should be constructed from existing tool factories, but filtered and wrapped by a subagent policy.

### Read-Only Tools

Useful for `explorer` and `researcher`:

- `read_file`
- `grep`
- `find_files`
- `read_code_outline`
- `code_context_search`
- `web_search`
- `web_fetch`

### Edit Tools

Only for `worker` and only inside `writeScope`:

- `apply_patch`
- `search_replace`
- `create_file`

The write policy should reject edits outside the explicit scope before the underlying tool runs.

### Shell Tool

Follow the same shell approval policy as the main agent.

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

Subagents can conflict with the parent agent or with each other. The minimum safe policy:

- Every edit-capable subagent must declare `writeScope`.
- Edit tools must verify target paths are inside `writeScope`.
- Use file locks for write tools so two sessions cannot modify the same file concurrently.
- The parent prompt should tell workers not to revert changes made by others.
- Worker final output must list changed files.

Potential later improvement: run each worker in a separate git worktree or branch and merge patches after review. That is safer for parallel edits but heavier to implement.

## Conversation Events

Add subagent-aware stream events in `source/services/conversation-events.ts`:

```typescript
export interface SubagentStartedEvent {
  type: 'subagent_started';
  agentId: string;
  role: string;
  task: string;
}

export interface SubagentTextDeltaEvent {
  type: 'subagent_text_delta';
  agentId: string;
  role: string;
  delta: string;
  fullText?: string;
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

The MVP may collect these internally and show a compact command message for `run_subagent`. The UI should eventually render subagent activity as collapsible nested output.

## Settings

Add general subagent settings while preserving mentor settings for compatibility.

```typescript
subagents: {
  enabled: boolean;
  defaultModel?: string;
  defaultProvider?: string;
  defaultReasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxConcurrent: number;
  roles: Record<string, {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    allowedTools?: string[];
    instructions?: string;
  }>;
}
```

Compatibility path:

- Keep `agent.mentorModel`, `agent.mentorProvider`, and `agent.mentorReasoningEffort`.
- Implement `ask_mentor` as a thin alias over `run_subagent({ role: 'worker', ... })`.
- Keep `/mentor` behavior initially, but internally route through the subagent infrastructure.

## Prompting

Add role prompt files under `source/prompts/subagents/`:

```text
source/prompts/subagents/explorer.md
source/prompts/subagents/worker.md
source/prompts/subagents/researcher.md
```

Every subagent prompt should include:

- Role and boundaries.
- Available tools.
- Explicit task.
- Context supplied by the parent.
- Workspace/write scope.
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
- Add command-message formatting for subagent runs.

### Phase 3: Add Edit-Capable Worker

- Add `worker` role.

### Phase 4: Async and Parallel Subagents (postponed)

- Add `spawn_subagent`, `wait_subagent`, `send_subagent`, and `abort_subagent`.
- Add `maxConcurrent`.
- Prevent overlapping write scopes unless explicitly serialized.
- Add subagent lifecycle UI events.

## Testing Strategy

Follow TDD for each phase.

High-value test cases:

- `run_subagent` rejects unknown roles when custom roles are disabled.
- Subagent receives only tools allowed by role and request.
- Read-only roles cannot access edit tools.
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
- Whether subagents should use the main model by default or require an explicit `subagents.defaultModel`. -> each subagent will have its definition in an md file with frontmatter format. The model will be specify there, default to 'inherit' if ommitted.
- Whether `/mentor` should remain a distinct mode or become a preset over `worker` subagents. -> `/mentor` will be a preset subagents.
- Whether async subagents should be visible as collapsible nested UI output or summarized as command messages until completion. -> keep it simple for now.
- Whether shell-capable subagents should be allowed to use the shell auto-approval policy by default. -> yes.
- Whether parallel workers should require disjoint `writeScope` declarations up front. -> The main agent is responsible for ensuring that the write scope is disjoint when prompting subagents. (phase 4)

## Recommended MVP

Build the synchronous path first:

1. Generalize `MentorSession` into `SubagentSession`.
2. Add `SubagentManager.run`.
3. Reimplement `ask_mentor` on top of `SubagentManager`.
4. Add `run_subagent` for read-only `explorer` and `reviewer`.
5. Add `worker` only after write-scope validation and changed-file reporting are in place.

This delivers useful worker delegation without forcing the UI and approval system to handle multiple active agents immediately.
