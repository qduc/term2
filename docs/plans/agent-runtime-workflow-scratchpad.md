# Programmable Agent Workflow Scratchpad

## Goal

Let the main agent write **ordinary TypeScript-like orchestration code** in a secure scratchpad that composes multiple subagents through the existing `agent(config).run(input)` API — no workflow DSL, no YAML pipelines, no new syntax. The agent expresses fan-out, sequential chains, and conditional dispatch in a single text block evaluated in an isolated runtime.

```typescript
// Example fan-out the agent writes
const [audit, tests] = await Promise.all([
  agent({
    name: "auditor",
    instructions: "Audit the auth module for security issues.",
    tools: ["read_file", "grep", "glob", "read_code_outline"],
    permissions: {
      tools: ["read_file", "grep", "glob", "read_code_outline"],
      filesystem: { read: ["source/auth/**"] },
    },
    limits: { maxTurns: 5, timeoutMs: 30000 },
  }).run({ task: "Find security issues in source/auth/" }),

  agent({
    name: "tester",
    instructions: "Find test gaps in the auth module.",
    tools: ["read_file", "grep", "glob"],
    permissions: { tools: ["read_file", "grep", "glob"] },
    limits: { maxTurns: 5 },
  }).run({ task: "Find missing test coverage in source/auth/" }),
]);

const summary = await agent({
  name: "summarizer",
  instructions: "Merge the following two findings into a concise report.",
  model: "efficient",
}).run({
  task: `Audit findings:\n${audit.output}\n\nTest gap findings:\n${tests.output}`,
});

return summary.output;
```

The agent writes this once. The `WorkflowEvaluator` runs it. All handles share a single `ExecutionBudget` that gates `maxChildren`, `maxDepth`, `maxConcurrency`, and `maxTokens`. The shared `AbortController` cancels the entire tree on timeout or budget exhaustion.

## Current Baseline

The following building blocks **already exist and are tested**:

| Component | Status | Location |
|-----------|--------|----------|
| `AgentRuntime` public facade | **completed** | `source/services/agent-runtime/agent-runtime.ts` |
| `AgentRuntime.agent(config) → AgentHandle` | **completed** | `source/services/agent-runtime/agent-runtime.ts` |
| `AgentHandle.run(input) → RunResult` | **completed** | `source/services/agent-runtime/agent-handle.ts` |
| `AgentConfig` / `AgentPermissions` / `AgentLimits` types | **completed** | `source/services/agent-runtime/types.ts` |
| Permission narrowing (intersect child ↔ parent) | **completed** | `source/services/agent-runtime/permission-resolver.ts` |
| Model policy resolution (tiered + relative + exact) | **completed** | `source/services/agent-runtime/model-resolver.ts` |
| Tool resolution + coarse-flag gating | **completed** | `source/services/agent-runtime/tools-resolver.ts` |
| Filesystem scope enforcement (glob + symlink-safe) | **completed** | `source/services/agent-runtime/scope-resolver.ts` |
| Network host scope enforcement + redirect guard | **completed** | `source/services/agent-runtime/scope-resolver.ts` |
| `ExecutionBudget` (tree-level child/token/concurrency) | **completed** | `source/services/agent-runtime/execution-budget.ts` |
| `SubagentToolPolicy` scope wrappers (read/write/shell/net) | **completed** | `source/services/subagents/tool-policy.ts` |
| `SubagentToolFactory` builds scoped tool lists | **completed** | `source/services/subagents/tool-policy.ts` |
| `SubagentDefinition` carries `executionBudget`, scopes, `tools[]` | **completed** | `source/services/subagents/types.ts` |
| `ExecutionSubagentRunner` consumes budgets + scopes | **completed** | `source/services/subagents/execution-runner.ts` |
| `NestedSubagentRunner` consumes budgets + scopes | **completed** | `source/services/subagents/nested-runner.ts` |
| `SubagentManager.getAgentRuntime()` bridge | **completed** | `source/services/subagents/subagent-manager.ts` |
| `SubagentBridge.getAgentRuntime()` public gateway | **completed** | `source/lib/subagent-bridge.ts` |
| `createAgentRuntime` composition root | **completed** | `source/services/agent-runtime/compose-agent-runtime.ts` |
| Unit + integration tests for all of the above | **completed** | `source/services/agent-runtime/*.test.ts` |

**What is missing**: The main model currently has no way to write and execute orchestration code. It only has `run_subagent` / `ask_mentor` as individual tool calls that occur in the model's reasoning loop — one at a time, with no shared budget, no concurrent fan-out from a single planning step, and no batch result collection. The `AgentRuntime` exists only in the Node.js host, not inside the model's tool surface.

## Architecture

### Model-Facing Tool: `run_agent_workflow`

The main agent gains a single new tool (analogous to the existing `run_subagent`):

```
run_agent_workflow({
  code: string,   // TypeScript-like orchestration
  timeoutMs?: number,
  maxChildren?: number,
  maxDepth?: number,
  maxTokens?: number,
})
```

The tool:
1. Receives the orchestration `code` block.
2. Delegates to `WorkflowEvaluator.evaluate(input)`.
3. Returns a `WorkflowResult` serialized as plain text for the model to continue reasoning.

The tool schema is intentionally minimal. The model describes the workflow in code; the tool description tells the model about `agent()`, `Promise.all()`, `sequential await`, and the return convention.

### Isolated WorkflowEvaluator

A new class `WorkflowEvaluator` owns the full lifecycle of one workflow invocation:

```
source/services/agent-runtime/workflow/workflow-evaluator.ts
source/services/agent-runtime/workflow/workflow-sandbox.ts
source/services/agent-runtime/workflow/workflow-scope.ts
```

`WorkflowEvaluator.evaluate(WorkflowInput)`:
1. Validates the input shape and code length limit.
2. Creates a **shared** `ExecutionBudget` from input limits (or workspace defaults).
3. Creates a `WorkflowScope` that exposes `agent(config)` bound to the shared budget.
4. Creates a single `AbortController` for the entire workflow (budget exhaustion + timeout + parent cancellation).
5. Evaluates the code in the sandbox.
6. Collects `WorkflowResult` and detaches all resources.

### WorkflowScope: The Shared AgentRuntime

`WorkflowScope` is the sandbox's global namespace. It exposes:

```typescript
interface WorkflowScope {
  // Create an agent handle bound to the shared budget.
  agent(config: AgentConfig): AgentHandle;

  // Resolved at workflow start; immutable for the workflow lifetime.
  readonly budget: ExecutionBudget;
  readonly signal: AbortSignal;
  readonly traceId: string;
}
```

Every `agent(config)` call produces an `AgentHandle` whose `run()` method is **bound** to the workflow's shared `ExecutionBudget`. This is the critical difference from the current `AgentHandle.run()`, which creates an **independent root budget** via `createRootBudget()`.

### Required Change: Budget-Bound AgentHandle.run()

**Current behavior** (line 257 of `agent-handle.ts`):

```typescript
const budget = createRootBudget({
  maxChildren: this.#definition.limits.maxChildren,
  maxDepth: this.#definition.limits.maxDepth,
  maxConcurrency: this.#definition.limits.maxConcurrency,
  maxTokens: this.#definition.limits.maxTokens,
});
```

Every `AgentHandle.run()` call creates a **new isolated** `ExecutionBudget`. This means:
- Two parallel handles from the same workflow each get independent budgets.
- `maxChildren` counts only direct children of each handle, not the total across the workflow.
- Token usage is tracked per-handle, not per-workflow.
- A budget-exhausted cancellation on one handle does not cancel siblings.

**Required behavior for workflow fan-out**: `AgentHandle.run()` must accept an **optional external budget**. When provided, the handle uses the shared budget instead of creating a root. The handle itself counts as a child in the shared budget (or as the root if it's the workflow's direct call).

The change needs to:

1. Extend `AgentHandleImpl` constructor to accept an optional `ExecutionBudget`.
2. Extend `AgentRuntime.agent()` (or a separate `WorkflowScope.agent()`) to pass the shared budget into the handle constructor — without changing the public `AgentRuntime.agent()` signature for existing callers.
3. In `AgentHandle.run()`, detect the presence of an external budget and skip `createRootBudget()`, using the external budget's `createChildBudget()` for depth tracking instead.

**Alternative design** (preferred): Add a `bindBudget(budget: ExecutionBudget): AgentHandle` method on `AgentHandle` that returns a new handle wrapping the same resolved definition but with the external budget. This is cleaner because it doesn't change the constructor signature and lets `AgentRuntime.agent()` remain budget-agnostic.

### Execution Flow

```
Main model writes code
        │
        ▼
run_agent_workflow tool invoked
        │
        ▼
WorkflowEvaluator.evaluate(input)
  ├─ Creates shared ExecutionBudget
  ├─ Creates shared AbortController (budget + timeout + parent signal)
  ├─ Creates WorkflowScope(budget, signal)
  ├─ Evaluates code in sandbox with scope
  │    ├─ agent(config) → AgentHandle bound to budget
  │    │    └─ handle.run(input)
  │    │         ├─ Tries sharedBudget.tryAcquireChild()
  │    │         ├─ On success: creates child budget, runs via executor
  │    │         ├─ On budget exhaustion: returns failed RunResult immediately
  │    │         └─ In finally: releases child slot
  │    │
  │    ├─ await handle.run(input)  → sequential
  │    ├─ await Promise.all([...]) → parallel (gated by maxConcurrency)
  │    └─ return value → serialized into WorkflowResult
  │
  ├─ Waits for all handles to settle (drain)
  ├─ Collects results, usage, errors
  └─ Returns WorkflowResult
        │
        ▼
Tool returns text serialization to main model
```

## Security Boundary

**Threat model**: The main model is an untrusted code generator. It may produce malicious JavaScript through hallucination, prompt injection, or adversarial inputs. The scratchpad code must execute with **no ambient authority**.

### Why Node `vm` Alone Is Insufficient

Node.js `vm` module (`vm.createContext`, `vm.compileFunction`, etc.) creates a V8 context with a custom global object. However:

1. **`Error().stack` leaks filesystem paths** and call-site information through stack traces, even in isolated contexts.
2. **`this.constructor.constructor('return this')()`** — the prototype chain escape. Even with a custom global, objects passed into the sandbox carry their original prototypes. A single reference to `{}` or `[]` can be used to reach `Function` via `({}).constructor.constructor`.
3. **Async stack frame retention**: `await` chains and Promise handlers retain references to outer context frames under some V8 versions, potentially leaking the host `Function` constructor through `.constructor` chains.
4. **Import assertions / dynamic `import()`**: `vm.compileFunction` cannot block dynamic import expressions unless the code is string-preprocessed, and some Node versions allow bypass via `import()` in async contexts.
5. **`SharedArrayBuffer` / `Atomics`**: `vm` does not isolate memory. Code can allocate shared buffers that persist after the context is destroyed.
6. **Uncatchable exceptions**: `process.abort()`, memory exhaustion, and infinite loops in tight synchronous code cannot be interrupted by the `vm` timeout mechanism (which only interrupts microtask checkpoints).

### Why Ordinary Shell Execution Is Insufficient

Running the code via `node -e` or `node --eval` in a child process:

1. **No capability attenuation**: The child process inherits the full Node.js API surface — `fs`, `child_process`, `net`, `os`, environment variables, file descriptors. There is no way to run a subset of Node.js without explicit lockdown.
2. **Signal handling gaps**: `SIGKILL` terminates the process but cannot produce a result. `SIGTERM` can be caught and ignored. Timeout-based kill races with async cleanup.
3. **Resource isolation**: CPU time, memory, file descriptors, and subprocess limits cannot be enforced without cgroups or OS-level containers. A single `while(true)` can saturate a core.
4. **No structured result capture**: stdout is a single byte stream. Errors, partial results, and usage data must be encoded ad-hoc and are fragile to parse.
5. **Cost**: Spawning a `node` process per workflow invocation is ~50–200 ms cold-start on typical hardware and adds memory overhead proportional to the Node.js heap, not the sandbox payload.

### Isolation Technology Decision

**Decision gate — not yet decided.** Two viable paths, evaluated below. The decision depends on what isolation primitives are available in the repository's runtime dependencies and target Node.js version.

| Criterion | `isolated-vm` (npm) | `workerd` / `Miniflare`-style isolate |
|-----------|---------------------|---------------------------------------|
| **Process boundary** | Yes (V8 isolate in separate thread, no Node.js event loop) | Yes (separate V8 isolate, no Node APIs) |
| **Memory limit** | Hard heap limit per isolate, enforced by V8 | Hard heap limit per isolate |
| **CPU time limit** | Wall-clock + CPU-time limits per invocation | Wall-clock limit per request |
| **Node API availability** | None by default; explicit transfer only | None (pure V8, no Node bindings) |
| **Structured data transfer** | `ExternalCopy` and `Reference` (copy-only, no shared mutable objects) | `Transferable` objects (copy-only) |
| **Async support** | `isolated-vm` supports async functions with Promise bridging | `workerd` supports async handlers |
| **npm dependency weight** | ~3 MB native addon, prebuilt binaries for Linux/macOS/Windows | Requires `workerd` binary (~20 MB) or Cloudflare Workers runtime |
| **Repository compatibility** | Must compile native addon (node-gyp); may break on musl/alpine | Binary dependency, no compilation |
| **Maintenance burden** | Low; mature library, minimal API surface | High; tied to Cloudflare release cycle |
| **Security track record** | Used in production by Fly.io, StackBlitz, CodeSandbox | Used in production by Cloudflare Workers |

**Recommendation**: Evaluate `isolated-vm` first. It is lighter, compiles to a small native addon, and provides exactly the primitives needed: a V8 isolate with no Node.js APIs, hard heap limit, wall-clock timeout, and structured copy-only data transfer. If native compilation fails in the target deployment environment, fall back to the evaluation below.

**Fallback consideration**: If neither isolation primitive is available, **do NOT ship**. The feature must be gated behind:
- A runtime capability check that probes for usable isolation.
- A feature flag (`enable_workflow_scratchpad`) that defaults to `false` and logs a diagnostic when the required primitive is unavailable.
- A clear error returned to the model: `"Agent workflow scratchpad is not available in this environment."`

**Stop condition**: Never evaluate untrusted code without a genuine process/isolate boundary. Node `vm` alone, `eval()`, `new Function()`, and shell subprocess execution are all insufficient. If no isolation technology passes review, the feature stays gated.

### Sandbox Design (assuming `isolated-vm`)

The sandbox provides **exactly**:

```typescript
// The ONLY globals available inside the sandbox:
{
  // Core JS: no prototype escape, no Function, no eval
  Object, Array, String, Number, Boolean, Date, Math, JSON,
  Map, Set, WeakMap, WeakSet, Symbol, BigInt,
  Promise, Error, TypeError, RangeError, SyntaxError,

  // Workflow-specific
  agent: (config: AgentConfig) => AgentHandleProxy,
  console: { log: (...args) => void },  // logged to trace, not stdout

  // NOT available:
  // Function, eval, require, import, process, global, globalThis,
  // setTimeout, setInterval, setImmediate,
  // Buffer, TextEncoder, TextDecoder,
  // fetch, XMLHttpRequest, WebSocket,
  // Atomics, SharedArrayBuffer,
  // Any Node.js built-in modules
  // Any prototype chain to the host realm
}
```

Agent handles returned by `agent()` inside the sandbox are **proxies** that marshal all interactions through `isolated-vm`'s `Reference`/`ExternalCopy` mechanism. The actual `AgentHandle.run()` executes in the host realm; only the resolved result is transferred back.

## Approval Policy

**Recommendation**: Start with **read-only, no-interactive-approval workflows only**, or workflows where all subagents use **pre-approved authority** (the main agent is in auto-approval mode for the tool classes the subagents need).

**Rationale**:

1. **Suspension complexity**: If `agent1` in a `Promise.all([agent1, agent2])` hits an approval-required tool, the entire workflow must suspend while the user decides. The evaluator must serialize the calling context (which Promise.all slot is stuck, what has completed, what hasn't started), present the approval, and resume. This requires full JS stack serialization — which `isolated-vm` does not natively support for `await` chains. The main conversation's approval infrastructure (`ApprovalFlowCoordinator`, `TurnStatusMachine`) is built around a single foreground approval, not a tree of suspended async contexts.

2. **User experience**: A paused workflow with multiple parallel agents is hard to present clearly. The user sees multiple pending operations and must decide which approval to handle first, potentially creating a deadlock where agent2 is blocked on agent1's file-lock and agent1 is waiting for approval.

3. **Pre-approved authority is safe**: The workflow already operates within a budget (maxChildren, maxTokens, maxDepth). If the main agent is running with auto-approved tools (e.g., green tools only, or the user has pre-approved reads), the subagents inherit that policy. The sandbox adds no new tools — it only composes existing ones.

**Deferred**: Full approval suspension/resume inside workflows. This requires:
- Serializable `AsyncLocalStorage`-style continuation tracking.
- `ApprovalFlowCoordinator` support for multiple concurrent approvals.
- UI that can display and route approvals for a tree of agents.

**MVP acceptable scope**: Workflows that fail on approval-required tools with a clear error: `"Workflow subagent requires interactive approval. Use pre-approved tool scopes or run a read-only workflow."`

## Contracts

### WorkflowInput

```typescript
export interface WorkflowInput {
  /** The orchestration code to evaluate. */
  code: string;
  /** Timeout for the entire workflow in milliseconds. */
  timeoutMs?: number;
  /** Maximum child subagents created across the workflow. */
  maxChildren?: number;
  /** Maximum nesting depth (parent → child → grandchild). */
  maxDepth?: number;
  /** Maximum concurrent subagent runs. */
  maxConcurrency?: number;
  /** Maximum tokens across all subagents in the tree. */
  maxTokens?: number;
  /** Parent cancellation signal. */
  signal?: AbortSignal;
}
```

### WorkflowResult

```typescript
export interface WorkflowResult {
  /** Terminal status. */
  status: 'completed' | 'failed' | 'cancelled' | 'budget_exhausted';
  /** When status is 'completed', the return value of the evaluated code serialized as text. */
  output?: string;
  /** Aggregate token usage across all agents in the workflow tree. */
  usage?: NormalizedUsage;
  /** Per-agent handles that ran, with status and error. */
  children?: WorkflowChildResult[];
  /** Typed error when status is not 'completed'. */
  error?: WorkflowError;
}

export interface WorkflowChildResult {
  name: string;
  status: 'completed' | 'failed' | 'cancelled' | 'budget_rejected';
  output?: string;
  error?: string;
  usage?: NormalizedUsage;
}

export interface WorkflowError {
  code:
    | 'timeout'
    | 'budget_exhausted'
    | 'syntax_error'
    | 'runtime_error'
    | 'sandbox_unavailable'
    | 'code_too_large';
  message: string;
}
```

### WorkflowScope

```typescript
export interface WorkflowScope {
  agent(config: AgentConfig): AgentHandle;
  readonly budget: ExecutionBudget;
  readonly signal: AbortSignal;
  readonly traceId: string;
}
```

### WorkflowEvaluator

```typescript
export interface WorkflowEvaluator {
  evaluate(input: WorkflowInput): Promise<WorkflowResult>;
}
```

## Implementation Phases (TDD)

### Phase 1: Budget-Bound AgentHandle (prerequisite)

**Why first**: Without this, every `agent().run()` creates its own independent budget, making fan-out budget enforcement impossible.

**Files**:
- `source/services/agent-runtime/agent-handle.ts` — add `bindBudget()` method, refactor `run()` to accept external budget
- `source/services/agent-runtime/agent-handle.test.ts` — or extend existing tests
- `source/services/agent-runtime/types.ts` — no change needed

**Tests**:
- `bindBudget()` returns a new handle that shares the parent budget
- Child handle's `run()` acquires a child slot on the shared budget
- Child slot release happens on both success and failure
- Token usage in child is recorded to the shared budget
- Budget exhaustion before `run()` returns `budget_rejected` typed error
- Budget exhaustion during `run()` cancels via shared abort signal
- Two handles bound to same budget respect `maxConcurrency`

### Phase 2: Sandbox Module (standalone)

**Files**:
- `source/services/agent-runtime/workflow/workflow-sandbox.ts` — `evaluateCode()` using isolation primitive
- `source/services/agent-runtime/workflow/workflow-sandbox.test.ts`

**Tests**:
- `agent(config)` is callable and returns a proxy handle
- `handle.run(input)` marshals correctly through the boundary
- `Promise.all([h1.run(), h2.run()])` resolves when both complete
- `console.log` is captured, not written to stdout
- `Function`, `eval`, `require`, `import`, `process` are not accessible
- `this.constructor.constructor('return this')()` does not escape
- Prototype chain escape through `({}).constructor.constructor` is blocked
- Stack trace from thrown error does not contain host filesystem paths
- Heap limit kills the isolate without affecting the host
- Wall-clock timeout aborts long-running code
- Code size limit rejects excessive input
- Syntax error produces clean `syntax_error` result
- Runtime `throw` produces clean `runtime_error` result

### Phase 3: WorkflowEvaluator

**Files**:
- `source/services/agent-runtime/workflow/workflow-evaluator.ts`
- `source/services/agent-runtime/workflow/workflow-scope.ts`
- `source/services/agent-runtime/workflow/workflow-evaluator.test.ts`

**Tests**:
- Evaluator creates shared budget from input limits
- Evaluator creates shared AbortController
- Sequential `await agent().run()` → `await agent().run()` produces two results in order
- `Promise.all([...])` with N handles respects `maxConcurrency`
- `maxChildren` gates total child count across the workflow
- `maxTokens` aggregate triggers abort for remaining children
- `timeoutMs` cancels the entire workflow, returns partial results
- `maxDepth` prevents recursive `agent()` calling `agent()` beyond limit
- Budget exhaustion produces `budget_exhausted` status
- Parent signal cancellation propagates to all children
- Cleanup: all child slots released after evaluator completes (even on error)
- Empty code block returns `completed` with no output
- Large return value is truncated to configurable limit

### Phase 4: run_agent_workflow Tool

**Files**:
- `source/tools/run-agent-workflow.ts` — tool definition
- `source/tools/run-agent-workflow.test.ts`

**Tests**:
- Tool is registered with name `run_agent_workflow`
- Tool schema includes `code`, `timeoutMs`, `maxChildren`, `maxDepth`, `maxTokens`
- Tool delegates to `WorkflowEvaluator.evaluate()`
- Tool serializes `WorkflowResult` as structured text for the model
- Tool description explains `agent()` and `Promise.all()` conventions
- `run_subagent` tool continues to work (no regression)

### Phase 5: Integration and Wiring

**Files**:
- `source/services/subagents/subagent-manager.ts` — wire `run_agent_workflow` tool
- `source/lib/subagent-bridge.ts` — expose `runAgentWorkflow` method
- `source/agent.ts` — register tool on main agent when feature flag is enabled
- `source/services/agent-runtime/index.ts` — export workflow types

**Tests**:
- End-to-end: agent writes code → tool evaluates → fan-out runs → result returned
- Existing tests for `run_subagent`, `ask_mentor`, `SubagentManager` all pass
- `SubagentManager.getAgentRuntime()` returns runtime usable in workflow scope

### Phase 6: Observability and Rollout

**Files**:
- `source/services/agent-runtime/workflow/workflow-tracer.ts` — structured trace for workflow tree
- Settings: `enable_agent_workflow` feature flag (default `false`)

**Tests**:
- Trace captures workflow start, each child start/end, workflow end
- Trace includes budget counters at each event
- Feature flag `false` prevents tool registration
- Feature flag `true` enables tool registration
- Graceful degradation when sandbox is unavailable

## Cancellation and Cleanup

1. **Shared AbortController**: Created at `WorkflowEvaluator` start. Passed to every child `AgentHandle.run()` via the budget. When any limit is reached or the parent cancels, `abortController.abort()` propagates to all active children.

2. **Child slot release**: Every child `AgentHandle.run()` releases its slot in a `finally` block. The `WorkflowEvaluator` also releases the root budget in its own `finally`.

3. **Isolate disposal**: After the workflow completes (or times out), the sandbox isolate is explicitly disposed with `isolate.dispose()`, freeing V8 heap.

4. **Orphan handling**: If the `WorkflowEvaluator` process terminates abnormally (crash, SIGKILL), OS-level process cleanup handles memory. No persistent state is stored — workflows are stateless.

## Resource Budget Invariants

- `childCount ≤ maxChildren` at all times. Enrollment is atomic and checked before increment.
- `activeChildren ≤ maxConcurrency` at all times. Incremented on start, decremented in finally.
- `aggregateTokens ≤ maxTokens` is soft-enforced: usage is recorded after each child completes. If the aggregate exceeds the limit, the shared abort signal fires, causing in-progress children to receive an abort and new children to be rejected at admission.
- `currentDepth ≤ maxDepth` at all times. Checked on `createChildBudget()`, throws if exceeded.
- `timeoutMs` fires an `AbortSignal.timeout()` composed with the parent signal via `AbortSignal.any()`.

## Rollout and Feature Flag

| Flag | Default | Effect |
|------|---------|--------|
| `enable_agent_workflow` | `false` | Controls registration of `run_agent_workflow` tool on the main agent |
| Runtime capability probe | auto | If no usable isolation primitive is available, the tool reports `sandbox_unavailable` instead of registering |

The feature flag is checked at agent construction time in `agent.ts`. When disabled:
- `run_agent_workflow` is not registered.
- Existing `run_subagent` / `ask_mentor` are unaffected.
- No sandbox code is loaded into the process.

## Explicit Non-Goals

- **No workflow DSL or YAML pipelines.** The agent writes JavaScript/TypeScript. No new language, no new parser.
- **No persistent workflows.** Workflows are stateless, one-shot evaluations. No continuation, no caching across turns.
- **No interactive approval inside workflows (MVP).** Workflows that encounter approval-required tools fail with a clear error. Pre-approved tool scopes only.
- **No async lifecycle tools (spawn/wait/send/abort) in workflows.** These are separate from the scratchpad feature and belong to the existing async subagent roadmap.
- **No workflow-to-workflow nesting.** A workflow cannot call `run_agent_workflow` inside its code. The sandbox has no access to the tool surface.
- **No immediate REPL or debugging inside the sandbox.** Errors are reported as structured `WorkflowResult`. No breakpoints, no step-through.
- **No persisted workflow templates or library.** The agent generates code fresh each time.
- **No domain-specific subagent primitives** beyond the existing `AgentConfig` shape. No specialized `code-reviewer()`, `test-runner()`, etc. — the agent produces those from `agent()`.

## Acceptance Criteria (End-to-End)

1. User says: "Audit the auth module and find test gaps, doing both in parallel."
2. Agent writes orchestration code in `run_agent_workflow` tool call.
3. Tool evaluates code; two subagents run concurrently under a shared budget.
4. Tool returns a `WorkflowResult` with both subagent outputs and aggregate usage.
5. Agent synthesizes a final response from the two outputs.
6. If the agent writes code exceeding `maxChildren`, the extra `agent().run()` calls return `budget_rejected` results.
7. If the workflow times out, partial results are returned with status `cancelled`.

## Security Acceptance Criteria

1. Malicious code in the sandbox cannot read/write files on the host (except through `agent()` handles, which are permission-gated).
2. Malicious code cannot access the network (except through `agent()` handles with `web_search`/`web_fetch`, which are host-scoped).
3. Malicious code cannot spawn subprocesses, load native modules, or call `require`.
4. Malicious code cannot escape the prototype chain to access `Function` or `eval`.
5. Malicious code cannot exhaust host memory — isolate heap is capped.
6. Malicious code cannot hang the host indefinitely — wall-clock timeout enforced.
7. A `while(true){}` in the sandbox does not block the Node.js event loop (guaranteed by isolate thread separation with `isolated-vm`).
8. Stack traces from sandbox errors do not contain host filesystem paths.
