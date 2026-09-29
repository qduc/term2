# Henshin agent runtime

## Resume here

Goal: make delegated behavior a per-invocation specification of the existing general agent runtime, not an expanding list of architectural role implementations. Assignment source: `/tmp/henshin-orchestrator-brief.md`. This plan is intentionally thin: retain compatibility with existing `run_subagent` callers while providing one generic execution path and optional thin presets. The final report belongs at `docs/plans/henshin-agent-runtime-report.md`.

## Current seam

`AgentRuntime.agent(config).run(input)` already implements one-shot execution with tools, permissions, model policy, limits, and context (`source/services/agent-runtime/`). `SubagentManager` and `SubagentAsyncRegistry` still dispatch against fixed roles; `role-loader.ts` maps role prompt frontmatter and model tier settings to definitions, while `run_subagent` validates a fixed enum. `source/agent.ts` registers the tool; `conversation-service` supplies the manager to the root agent. Existing role pools and prompts are compatibility presets, not independent execution mechanics. Mentor has a distinct retained-session path and must not silently lose its continuation behavior.

## Delivery

1. Add an invocation-level `AgentSpec`/`runAgent` path over the existing runtime, reusing its resolver, tool policy, execution runner and result contracts. Specify goal, context, tools/permissions, constraints, completion criterion, model policy and limits without requiring a named role. Preserve permission narrowing and budget limits.
2. Make the orchestrator-facing delegation surface accept dynamic specs and route them through the shared execution mechanics, preserving asynchronous run handles, cancellation, notifications, worktree pinning, approvals and existing role-based callers. Legacy names remain thin defaults and pool aliases rather than separate architectures. Do not turn every role into a new hard-coded taxonomy.
3. Cover dynamic read-only and write-capable runs, permission/budget enforcement, continuation/cancellation and legacy compatibility with focused tests; run related/changed tests and typecheck. Independently review, triage and fix blocking findings, then merge with `git merge --no-ff`.

## Constraints and tradeoffs

Do not rewrite provider/session execution or discard legacy role settings in the first migration: those are deployment compatibility, not an architectural reason for distinct workers. Sidecar/memory remains outside disposable execution. Explicitly document any incomplete migration in the final report rather than claiming elimination of existing compatibility names.
