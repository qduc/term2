# One sandboxed code host for `run_agent_workflow` and `run_code`

Status: **proposed, not started.** Nothing in this plan is implemented. It exists
because `run_code` shipped on `main` (`9df91d20`) and is currently non-functional
in normal mode; before patching it further we should decide whether it belongs on
its own execution engine at all.

## Resume here

Read this first if you are touching `run_code`, `run_agent_workflow`, or
`source/services/agent-runtime/workflow/`.

Decisions already taken, with the reasoning that produced them:

- **`run_code`'s process-based design is the source of its defect list, not an
  implementation slip.** Two independent external reviews (`REVIEW-run-code-*.md`,
  `REVIEW2-run-code-*.md`) found: the Unix socket cannot cross the Linux sandbox
  (`allowUnixSockets` is ignored there and seccomp blocks `AF_UNIX`); the sandbox
  runtime reports *available* when seccomp is missing, leaving every host socket
  reachable; holding the process-wide sandbox lease across execution deadlocks any
  `tools.shell` call; and running the child on `process.execPath` requires Node
  23.6+ while the package declares `engines: node >=20`. Every one of these is a
  consequence of "separate OS process talking over a socket."
- **The sandbox was deliberately removed** (product decision, 2026-09-04): scripts
  run unsandboxed and `run_code` never prompts, on the rationale that each
  `tools.*` call is still guarded. Do not reintroduce an OS sandbox. This plan
  keeps that decision and makes the rationale *true* rather than aspirational.
- **`run_agent_workflow` already solved the isolation problem.** It runs code in a
  worker thread inside `vm.createContext` over an `Object.create(null)` sandbox
  exposing only `agent` and `console`, with `codeGeneration` disabled. Code there
  never has `require`, `fs`, or `net` — not because they are blocked, but because
  they were never present.
- **The two tools differ only in what is injected.** Everything else the evaluator
  does is capability-agnostic.

Premise already disproven: *"binding the wrapped registry makes `run_code`'s tool
calls follow normal policy."* It closed the plan-mode bypass, but
`wrapNeedsApproval` returns `true` unconditionally once a registry is supplied
(`source/lib/tool-invoke.ts:549`) — a sentinel meaning "let the run loop's approval
coordinator decide," not "prompt the user." The bridge reads it literally and now
refuses **every** call outside YOLO mode. Any design here must resolve approval
through the same seam the run loop uses, not by calling the wrapped
`needsApproval` and believing the answer.

## Goal

**One engine for "the model wrote a program"; two tools for what the program can
reach.**

`run_agent_workflow` and `run_code` are the same mechanism — a model writes code,
the code runs somewhere disposable, the code calls back into the harness, output
comes back — pointed at two different callback surfaces. Workflow injects
`agent(config).run(...)` and orchestrates child agents. `run_code` injects
`tools.<name>(params)` and drives the toolset directly.

Today that shared mechanism exists twice. The workflow copy is a 342-line
lifecycle machine covering worker creation, abort, admission control, concurrency
permits, timeouts, byte budgets, console capture, JSON-safe validation, and run
summaries. The `run_code` copy reimplements the same concerns worse: a Unix socket
instead of `postMessage`, a promise chain instead of admission control, and a
`stop()` that drains only part of what it started.

The test for every choice below: **if a change makes the two tools differ anywhere
except the object injected into the sandbox, the design has slipped.**

## Why merging is the cheaper path than patching

Outstanding `run_code` defects, and what happens to each under this plan:

| Defect | Under a vm/worker host |
|---|---|
| Linux seccomp blocks the bridge socket | Gone — no socket |
| Sandbox available while seccomp missing | Gone — no OS sandbox dependency |
| Node `>=20` engine vs. native type stripping | Gone — no child process |
| Temp dir cannot resolve project `node_modules` | Gone — no temp dir |
| `tsx` not shipped in the published package | Gone — no transpiler |
| Malformed / oversized socket frames | Gone — `postMessage`, structured |
| `stop()` misses `parallelSafe` calls | Fixed by the shared permit accounting |
| Mixed parallel/serial calls race `ExecutionContext` | Fixed by the shared admission control |
| Script body has unrestricted host access | Fixed — the sandbox has no ambient globals |
| Approval sentinel misread | **Not fixed by this plan.** Must be solved explicitly (Milestone 3) |

Nine of ten stop being possible. The tenth is the one that actually needs design
work, and today it is buried under the other nine.

## Design

### The host

Extract from `workflow-evaluator.ts` a capability-agnostic host:

```ts
interface SandboxedCodeHost {
  run(input: {
    code: string;
    capabilities: Record<string, CapabilityHandler>;
    limits: HostLimits;
    signal?: AbortSignal;
  }): Promise<HostResult>;
}

type CapabilityHandler = (payload: JsonValue) => Promise<JsonValue>;
```

The worker injects one proxy per capability name onto the sandbox object. Each
proxy posts `{ type: <name>, requestId, payload }`; the host dispatches on `type`
and posts the result back. This is exactly the existing `agent.run` path with the
message type made a parameter instead of a constant.

`run_agent_workflow` becomes `capabilities: { agent }`. `run_code` becomes
`capabilities: { tools }`, where the `tools` proxy is a nested object, one member
per exposed tool name.

### What each tool keeps

| | `run_agent_workflow` | `run_code` |
|---|---|---|
| Injected | `agent(config).run(input)` | `tools.<name>(params)` |
| Handler | spawn child agent via `AgentRuntime` | re-enter the tool registry |
| Policy | capability inheritance, checked at config time | per-call approval + interceptors |
| Limits | runs, concurrency (agent-shaped) | call count (tool-shaped) |
| Prohibited | `ask_user`, `run_subagent`, `run_agent_workflow` | the same set, plus `run_code` |

Limits must be per-capability, not shared constants: workflow caps runs at 8 with
concurrency 3, which is right for spawning agents and absurd for reading 200 files.

## Costs, stated plainly

**The typed `tools` namespace is lost.** `vm.Script` runs JavaScript; workflow code
is explicitly "not TypeScript" for this reason. Today `run_code` generates a real
TypeScript module with per-tool parameter interfaces derived from each Zod schema —
that was the stated reason for choosing TypeScript. Under the host, parameter
shapes become documentation (in the tool description, or a generated comment
header) and the only enforcement is the host-side schema validation that already
runs. Reviewers already found the generated types cannot express `superRefine`
conditions, so they were never fully honest — but this is still a real reduction,
and it should be a conscious trade rather than a side effect.

**The worker source becomes generated.** `WORKFLOW_WORKER_SOURCE` is currently a
static `String.raw` block, which is easy to audit. Injecting a dynamic capability
list means generating it. Mitigation: generate only the *names* into a fixed
template, never handler bodies, and assert the generated source against a snapshot
in tests.

**Behaviour change for `run_code` scripts.** A script loses `fs`, `net`, `require`,
and `eval`. That is the point, and it matches the security rationale given when the
sandbox was removed — but any script that reached the host directly will now fail.
Nothing depends on this yet; `run_code` has never worked in normal mode.

## Milestones

**M1 — Extract the host, no behaviour change.** Move the lifecycle out of
`WorkflowEvaluatorImpl` into the host; re-point `run_agent_workflow` at it with
`capabilities: { agent }`. The existing 428-line `workflow-evaluator.test.ts` and
`run-agent-workflow.test.ts` are the safety net and must pass unmodified. If they
need edits, the extraction changed behaviour and is wrong.

**M2 — Rebuild `run_code` on the host.** Replace the socket bridge and generated
TypeScript module with a `tools` capability. Delete `tool-bridge.ts`,
`runtime-module.ts`, and their tests. Port the tests that still describe real
contracts: schema validation, unknown tool, result truncation, call budget,
self-exclusion, per-call approval refusal.

**M3 — Fix approval resolution properly.** The blocking correctness question, and
the reason it gets its own milestone rather than being folded into M2. The host
must ask the same authority the run loop asks — the approval-policy registry — not
the wrapped `needsApproval`. Requires reading how `toolApprovalPolicyRegistry` and
the batch approval coordinator resolve a decision, and exposing that as a seam a
non-run-loop caller can use. Until this lands, `run_code` stays refused-by-default
and is honest about it.

**M4 — Align prohibited tools.** Apply `WORKFLOW_PROHIBITED_TOOLS` to `run_code`
too. Both external reviews flagged that a script can currently loop on
`tools.run_subagent`, spawning agents outside any run budget.

## Open questions

1. **Should `run_code` survive as a separate tool at all,** or become
   `run_agent_workflow` with a `tools` capability flag? Two tools give the model a
   clearer choice; one tool is less surface. This plan assumes two.
2. **Does the approval seam in M3 want a synthetic tool-call ID?** Reviewers noted
   `details.toolCall.callId` is required by the post-execute pause path and the
   shell denied-read path, which currently throw `HarnessInvariantError` when it is
   absent. A bridge-issued ID may be acceptable, or these paths may need to be
   genuinely unavailable from inside a script.
3. **Is losing the typed namespace acceptable?** If not, the alternative is
   type-stripping the user's code on the host before handing JavaScript to `vm` —
   which reintroduces a transpiler dependency, though an in-process one.

## Provenance

- `REVIEW-run-code-review-gemini.md`, `REVIEW-run-code-review-codex.md` — first-pass
  reviews of `21512184` (Gemini 3.8 Flash and gpt-5.6-luna, independently).
- `REVIEW2-run-code-review-gemini.md`, `REVIEW2-run-code-review-codex.md` —
  re-reviews of the rework `b172135f`.
- The approval-sentinel behaviour was reproduced directly against
  `wrapNeedsApproval`; it is not inferred from the reviews.
