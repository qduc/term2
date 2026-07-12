# Programmable Agent Workflow MVP

## Status

Implementation plan for the first shippable version of programmable agent workflows in Term2.

This document deliberately describes the smallest useful version. It validates the core idea without committing Term2 to a workflow engine, a public scheduling framework, or a large resource-management API.

## Goal

Allow the main agent to submit a short JavaScript program that creates temporary subagents, runs them sequentially or concurrently, and returns a JSON-safe result.

```js
const scopes = ["security", "test coverage"];

const results = await Promise.all(
  scopes.map(async (scope) => {
    const reviewer = agent({
      name: `${scope}-reviewer`,
      instructions: `Review the requested code for ${scope}. Report concrete findings only.`,
      model: "lower",
      tools: ["read_file", "grep", "glob"],
    });

    return reviewer.run({
      task: `Review source/auth for ${scope}.`,
    });
  }),
);

return results;
```

The workflow is ordinary modern JavaScript with top-level `await`.

The MVP does not support TypeScript syntax, imports, modules, persistent workflows, or a custom workflow DSL.

## Hypothesis

The MVP succeeds if the main agent can use one tool call to dynamically:

- create specialized subagents;
- isolate their model contexts;
- run independent work concurrently;
- select a relative model tier;
- restrict each agent to an allowed tool subset;
- collect structured results;
- stop runaway workflows.

PR review fan-out is the primary validation case.

## Existing Foundation

Term2 already has:

- `AgentRuntime.agent(config)`;
- `AgentHandle.run(input)`;
- model selection and tool resolution;
- permission-aware subagent execution;
- execution budgets and nested subagent support;
- `SubagentManager` and `SubagentBridge`.

The missing capability is a model-facing surface that can compose several agent runs in one orchestration step.

## Model-Facing Tool

Add one tool:

```ts
run_agent_workflow({
  code: string;
})
```

The model supplies JavaScript source. Runtime limits come from Term2 configuration, not from model-provided arguments.

This keeps the tool schema small and prevents generated code from negotiating its own authority or resource limits.

The tool description documents:

- the injected `agent(config)` function;
- `AgentHandle.run(input)`;
- sequential `await`;
- `Promise.all()` for concurrency;
- the requirement to `return` a JSON-safe value.

## Sandbox API

Workflow code receives exactly two application-level globals:

```ts
interface WorkflowGlobals {
  agent(config: WorkflowAgentConfig): WorkflowAgentHandle;
  console: {
    log(...values: JsonValue[]): void;
  };
}
```

The sandbox does not receive:

- `AgentRuntime`;
- `ExecutionBudget`;
- abort controllers or signals;
- trace identifiers;
- host tool objects;
- model clients;
- filesystem or network APIs;
- environment variables;
- module loading.

`agent()` returns a sandbox proxy. The real agent handle remains in the host process.

## Agent Contract

```ts
export interface WorkflowAgentConfig {
  name?: string;
  instructions: string;
  model?: "lower" | "default" | "higher";
  tools?: string[];
}

export interface WorkflowRunInput {
  task: string;
  context?: JsonValue;
}

export type WorkflowRunResult =
  | {
      ok: true;
      output: JsonValue;
      usage?: NormalizedUsage;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      usage?: NormalizedUsage;
    };

export interface WorkflowAgentHandle {
  run(input: WorkflowRunInput): Promise<WorkflowRunResult>;
}
```

Normal agent failures resolve to `WorkflowRunResult`; they do not reject the workflow promise.

Sandbox syntax errors, runtime exceptions, invalid return values, and evaluator failures terminate the workflow.

## Workflow Contract

```ts
export interface WorkflowInput {
  code: string;
  signal?: AbortSignal;
}

export type WorkflowResult =
  | {
      ok: true;
      output: JsonValue;
      runs: WorkflowRunSummary[];
    }
  | {
      ok: false;
      error: WorkflowError;
      runs: WorkflowRunSummary[];
    };

export interface WorkflowRunSummary {
  name?: string;
  ok: boolean;
  durationMs: number;
  usage?: NormalizedUsage;
  errorCode?: string;
}

export interface WorkflowError {
  code:
    | "syntax_error"
    | "runtime_error"
    | "timeout"
    | "limit_exceeded"
    | "approval_required"
    | "sandbox_unavailable"
    | "invalid_output"
    | "code_too_large";
  message: string;
}
```

`output` may contain only JSON-safe values.

`runs` is a flat diagnostic log of attempted agent runs. It is not a workflow tree and is not the semantic output of the workflow.

## Runtime Limits

The evaluator reads fixed limits from workspace or application configuration:

```ts
export interface WorkflowLimits {
  timeoutMs: number;
  maxRuns: number;
  maxConcurrency: number;
  maxCodeBytes: number;
  maxOutputBytes: number;
}
```

Recommended initial defaults:

```ts
{
  timeoutMs: 120_000,
  maxRuns: 8,
  maxConcurrency: 3,
  maxCodeBytes: 16_384,
  maxOutputBytes: 65_536,
}
```

Rules:

- creating an agent handle is free;
- every `handle.run()` consumes one cumulative run admission;
- completed runs do not restore `maxRuns`;
- active runs may not exceed `maxConcurrency`;
- the entire workflow shares one timeout and parent cancellation signal;
- output exceeding `maxOutputBytes` fails with `invalid_output`.

Aggregate token budgeting and public budget binding are deferred. Existing per-agent limits remain active.

## Tool Authority

The workflow may request only tools already available to the parent agent and explicitly allowed for workflows.

```text
resolved tools =
  requested tools
  ∩ parent tools
  ∩ workflow allowlist
```

The workflow cannot broaden permissions.

For the MVP:

- prefer read-only tools;
- reject tools requiring interactive approval;
- do not suspend and resume workflows around approvals;
- return `approval_required` when a child attempts such an operation.

No separate workflow permissions language is introduced.

## Execution Architecture

```text
Main agent
  │
  ▼
run_agent_workflow
  │
  ▼
WorkflowEvaluator
  ├── validates source and limits
  ├── owns timeout, cancellation, counters, and run log
  ├── hosts real AgentHandle executions
  └── communicates with a disposable workflow worker
        └── evaluates JavaScript with injected agent() proxy
```

The worker sends structured requests to the host:

```ts
type WorkerMessage =
  | {
      type: "agent.run";
      requestId: string;
      config: WorkflowAgentConfig;
      input: WorkflowRunInput;
    }
  | {
      type: "workflow.complete";
      output: JsonValue;
    }
  | {
      type: "workflow.error";
      error: SerializedError;
    };
```

The host validates every request before executing it.

## Isolation Decision

The workflow source is untrusted generated code.

The MVP must run it outside the Term2 host process in a disposable worker with:

- no inherited application objects;
- no direct tool, filesystem, network, environment, or model access;
- a hard workflow timeout;
- worker termination during cleanup;
- structured message passing only.

A plain in-process `eval`, `new Function`, or Node `vm` context is not an acceptable security boundary.

The exact worker isolation technology is an implementation decision. Shipping is gated on a focused security review and escape tests. Do not expand the public API based on the chosen sandbox library.

## WorkflowEvaluator Responsibilities

```ts
export interface WorkflowEvaluator {
  evaluate(input: WorkflowInput): Promise<WorkflowResult>;
}
```

For each invocation it:

1. validates source size and input;
2. starts a disposable workflow worker;
3. injects the minimal workflow API;
4. tracks cumulative and active runs;
5. validates requested models and tools;
6. executes real agents through the existing runtime;
7. records a flat run summary;
8. enforces timeout and parent cancellation;
9. validates the returned JSON-safe output;
10. terminates the worker and releases resources.

It does not implement retries, planning, workflow persistence, approval suspension, or semantic aggregation.

## Implementation Plan

### Phase 1: Host-side evaluator

Create:

```text
source/services/agent-runtime/workflow/workflow-evaluator.ts
source/services/agent-runtime/workflow/workflow-types.ts
```

Implement request validation, limits, concurrency gating, agent execution, flat run logging, output validation, cancellation, and cleanup.

Reuse the existing agent runtime. Avoid adding public `bindBudget()` or another general execution-scope API unless implementation proves it unavoidable.

### Phase 2: Disposable workflow worker

Create:

```text
source/services/agent-runtime/workflow/workflow-worker.ts
source/services/agent-runtime/workflow/workflow-sandbox.ts
```

Implement source evaluation, the `agent()` proxy, top-level `await`, structured host messages, console capture, and final return serialization.

### Phase 3: Model-facing tool

Create:

```text
source/tools/run-agent-workflow.ts
```

Register it on the main agent behind:

```text
enable_agent_workflow = false
```

The tool accepts only `code`.

### Phase 4: End-to-end validation

Validate with a parallel auth review:

- one agent reviews security;
- one agent reviews missing tests;
- both use lower-tier models and read-only tools;
- the workflow returns both results;
- the main agent synthesizes the final report.

Use Mentor-style consultation as the second validation case.

## Required Tests

Evaluator tests:

- sequential runs preserve order;
- `Promise.all()` runs concurrently;
- cumulative runs cannot exceed `maxRuns`;
- active runs cannot exceed `maxConcurrency`;
- invalid tools are rejected;
- tools outside the parent authority are rejected;
- approval-required tools fail clearly;
- parent cancellation stops active work;
- timeout terminates the workflow;
- cleanup occurs after success and failure;
- output must be JSON-safe and size-bounded.

Sandbox tests:

- syntax errors are reported cleanly;
- runtime exceptions are reported cleanly;
- `agent().run()` marshals requests and results;
- console output is captured;
- module loading and Node globals are unavailable;
- workflow code cannot access host objects;
- infinite loops cannot hang the Term2 host;
- terminating the worker does not terminate the host.

Integration tests:

- main agent tool call produces two parallel subagent runs;
- both results return to the main agent;
- existing `run_subagent` and `ask_mentor` behavior is unchanged;
- disabling the feature flag removes the tool;
- sandbox unavailability returns `sandbox_unavailable`.

## Acceptance Criteria

The MVP is complete when this flow works reliably:

1. The user asks Term2 to review two independent concerns in parallel.
2. The main agent calls `run_agent_workflow` once with generated JavaScript.
3. Two isolated subagents execute concurrently.
4. Each receives only its own instructions, task context, model tier, and permitted tools.
5. The workflow returns JSON-safe results and a flat run log.
6. Term2 synthesizes the user-facing answer.
7. Run count, concurrency, timeout, cancellation, and cleanup are enforced.
8. Existing subagent features continue to work unchanged.

## Explicit Non-Goals

The MVP does not include:

- TypeScript compilation;
- imports or user modules;
- a workflow DSL;
- persisted workflow templates;
- workflow caching or continuation;
- interactive approval suspension;
- workflow-to-workflow nesting;
- persistent agent handles;
- skills attached inside workflow code;
- memory integration;
- hierarchical or aggregate token budgets;
- public budget-binding APIs;
- trace trees or a workflow debugger;
- retries, queues, events, cron, or workflow-engine semantics;
- domain-specific agents such as `reviewer()` or `mentor()`.

## Follow-up Triggers

Add deferred features only in response to demonstrated need:

- aggregate token limits when real workflows create unacceptable cost variance;
- richer tool scoping when the existing parent/tool allowlist is insufficient;
- nested workflows when a concrete use case cannot be expressed with ordinary agents;
- reusable workflow templates when generated workflows become repetitive;
- skills when runtime-level attachment is clearly better than resolving them before agent creation;
- approval suspension only after Term2 supports multiple concurrent resumable approvals.

## Design Boundary

The runtime provides bounded execution, isolation, and agent creation.

The JavaScript workflow provides orchestration.

Term2 remains an agent runtime, not a workflow engine.
