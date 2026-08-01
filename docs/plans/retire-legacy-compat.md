# Retiring `source/services/agent-runtime/legacy-compat.ts`

**Status:** Not started. Scoping complete.
**Last updated:** 2026-08-01
**Parent plan:** `docs/plans/decouple-from-openai-agents-sdk.md` (§ *`legacy-compat.ts` is a shim, not a finished slice*)

---

## Resume here

Read this section and *Findings* before touching anything. Three things are established and
should not be re-derived:

1. **This is not a refactor. Parts of the shim are already broken in production.** Nested
   subagents cannot return a result, subagent tool bookkeeping is inert, and edit healing
   always fails. Evidence in *Findings* below. Any slice that "preserves current behavior"
   for those paths is preserving a bug — pin the *intended* behavior instead.
2. **The endpoint is not "same shapes, better types."** The parent plan's whole point is that
   re-implementing `Agent` / `Runner` / `RunContext` in-house relocates the SDK's fragility
   rather than retiring it. The replacement is purpose-built per call site, sized to what the
   call site actually does.
3. **`ApplicationRunLoop` is the destination, and it has a real gap.** It does not carry a
   per-run user context into tool invocation. That gap is why subagent bookkeeping is dead.
   Closing it is slice 3 and it is a prerequisite for slices 4–6, not an optional cleanup.

### Landed

Nothing yet.

---

## What the shim is

`source/services/agent-runtime/legacy-compat.ts` (227 lines) re-implements the removed SDK's
class *shapes* locally: `Agent`, `Runner`, `RunContext`, `tool()`, `applyPatchTool`, `run()`,
plus `adaptLegacyModel`. Config bags are `any`; approval bookkeeping is the SDK's
tool-name-keyed record verbatim.

### Export inventory and disposition

| Export | Production consumers | Disposition |
|---|---|---|
| `applyPatchTool` | **none** | Delete (slice 1) |
| `run()` | `subagents/utils.ts:76`, `tools/file/edit-healing.ts:206` | Delete; it only throws (slice 2) |
| `adaptLegacyModel` | `Runner.run` only | Delete with `Runner` (slice 2) |
| `Runner` | `subagents/nested-runner.ts:260` — reads `.config` and nothing else | Delete (slice 2) |
| `Agent` | `execution-runner.ts:187`, `mentor-runner.ts:145`, `nested-runner.ts:249`, `edit-healing.ts:179` | Replace with plain `ApplicationAgent` object literals (slice 4) |
| `RunContext` | `nested-runner.ts:384` (constructs), `tool-policy.ts` (type only) | Replace with `ToolInvocationContext` + a typed approval ledger (slices 3, 5) |
| `tool()` / `Tool` | `tool-policy.ts:985` (`buildAgentTools`), `subagent-manager.ts`, `nested-runner.ts` | Replace with `ToolDefinition` (slice 6) |

Test-only importers to migrate alongside: `lib/agent-factory.test.ts`,
`lib/tool-invoke.test.ts`, `providers/agents-model-bridge.test.ts`,
`services/approval/approval-replay.test.ts`, `tools/file/glob.test.ts`,
`tools/file/grep.test.ts`, `services/agent-runtime/legacy-compat.test.ts`.

---

## Findings — what is already broken

These were found while scoping. They are the reason this work is not cosmetic.

### F1. Nested subagents cannot return a result

`Agent.asTool()` (`legacy-compat.ts:96-107`) builds a tool whose `execute` returns
`inputBuilder({params})` and stops. It silently drops every other key it is handed.
`nested-runner.ts:271-321` passes `runConfig`, `runOptions`, `resumeState`, and
`customOutputExtractor` — **none of which are read**. There is no nested run at all.

Consequence: `runAsTool` receives the raw task string, and
`parseNestedSubagentResult` (`nested-runner.ts:82`) calls `JSON.parse` on it, throwing a
`SyntaxError` that surfaces as a failed subagent.

Not caught by tests: `nested-runner.test.ts` no longer exercises `NestedSubagentRunner`
at all — both its tests drive `ApplicationRunLoop` directly.

### F2. Subagent tool bookkeeping is inert under the new loop

`ApplicationRunLoop.#invokeTool` (`application-run-loop.ts:330-335`) passes the loop's
*options* object (`{signal, sessionId}`) as the tool `context`. Every subagent policy that
reads `context.context` therefore gets `undefined`:

- `getSubagentRunContext` (`tool-policy.ts:62`) → `undefined`
- `filesChanged` accumulation (`tool-policy.ts:532`)
- `toolCounts` / `activeCommandMessages` / `subagent_tool_started` events
  (`nested-runner.ts:184-228`)
- `injectTurnLimitWarning(result, _context?.context)` (`tool-policy.ts:1008`) — the turn-limit
  warning can never be injected

`ApplicationRunLoop` has no slot for a per-run user context. This is the gap slice 3 closes.

### F3. Edit healing always fails on OpenAI, and returns empty text elsewhere

`edit-healing.ts:164` only builds a runner when `providerId !== 'openai'`; the OpenAI branch
falls through to `run()` (`legacy-compat.ts:153`), which unconditionally throws. The throw is
caught at `edit-healing.ts:272` and degrades to `failureReason: healing request failed: …`.

On non-OpenAI providers the runner comes from `createApplicationCompatibilityRunner`
(`providers/registry.ts:81-88`), whose `run()` returns a **live stream**, not a settled
result. `extractModelText(result)` (`edit-healing.ts:88`) reads `result.finalOutput` before
`completed` resolves, so it reads `undefined` → empty output → `'model returned empty output'`.

### F4. Mentor final text has the same stream-vs-result mismatch

`mentor-runner.ts:174` awaits `runWithProvider(...)`, which resolves to the same unsettled
stream, then reads `extractFinalText(result)` and `result?.state?.usage`. Both read a stream
that has not run. `utils.ts:76` has the same OpenAI-throws branch as F3.

### F5. `RunContext` is an untyped approval side-channel

`nested-runner.ts:392` replays parent approvals into a fresh `RunContext` via
`readParentApprovals(context)` — a structural `toJSON()` probe on whatever the loop handed the
tool. Under the current loop that is the options object, which has no `toJSON`, so
`readParentApprovals` returns `undefined` and **no parent approval is ever replayed into a
subagent**. The user re-approves tools they already approved.

`approval-replay.ts` itself is fine: it depends only on a two-method `ApprovalContext`
interface and its semantics are documented and tested. It does not need `RunContext`.

---

## Target design

Four small application-owned pieces replace the seven SDK-shaped exports.

### 1. `ApplicationAgent` object literals (already exists)

`ApplicationAgent` (`application-run-loop.ts:18-26`) is the agent shape. `lib/agent-factory.ts`
already builds one without `legacy-compat`; it is the precedent. `new Agent({...})` becomes an
object literal. `Agent.clone()` has zero call sites. `Agent.asTool()` is replaced by piece 4.

Tighten while migrating: `modelSettings` and `defaultRunOptions` are `any` on `ApplicationAgent`.
Give `modelSettings` a named type covering the fields the loop and providers actually read
(`temperature`, `reasoning`, `maxTokens`, `retry.maxRetries`). Do not model fields nobody reads.

### 2. `ToolInvocationContext<T>` — the per-run context slot

New contract, owned by `contracts/` or `agent-runtime/`:

```ts
export interface ToolInvocationContext<T = unknown> {
  readonly context: T;              // the run's user context (e.g. SubagentRunContext)
  readonly approvals: ApprovalLedger;
  readonly signal?: AbortSignal;
}
```

`ApplicationRunLoopOptions` gains `context?: unknown`; `RunState` carries it; `#invokeTool` and
`needsApproval` receive a `ToolInvocationContext` instead of the raw options object. The
`.context` accessor keeps `getSubagentRunContext` working unchanged, which is what makes F2 a
one-seam fix rather than a sweep.

Continuation must preserve it: `continueRunStream` restores `state.context` so an approved tool
resumes with the same bookkeeping object.

### 3. `ApprovalLedger` — typed replacement for `RunContext`'s approval half

Same four operations (`approveTool`, `rejectTool`, `isToolApproved`, `getRejectionMessage`) and
the same semantics — which are **not** incidental: they are documented in the parent plan
(§ *`ApprovalRecord` semantics, established by reading the SDK source*) and pinned by
`approval-replay.test.ts`. Preserve them exactly; the fidelity limit recorded there still applies.

Changes from `RunContext`:

- typed `ApprovalItem { toolName, callId }` input instead of `any` shape-probing across
  `item.toolName ?? item.rawItem?.name`;
- an explicit `snapshot(): Readonly<Record<string, ApprovalRecord>>` replacing the
  `toJSON()` probe in `readParentApprovals`, so parent→child replay is a typed call (fixes F5);
- reuses the existing exported `ApprovalRecord` from `approval-replay.ts`.

It does **not** carry the run's user context. That is `ToolInvocationContext.context`. Splitting
these is the point: `RunContext` conflated an approval ledger with a context bag, and every
`any` in the subagent tool signatures traces back to that.

### 4. `createSubagentTool()` — explicit nested run

Replaces `agent.asTool({...})` in `nested-runner.ts` with a local function that builds a
`ToolDefinition` whose `execute` actually runs the role agent through `ApplicationRunLoop`,
then applies the output extraction that `customOutputExtractor` was supposed to do:
final text, `filesChanged`, `toolCounts`, usage, interruption claim into `ToolOwnershipRegistry`.

Fixes F1. The dropped `runConfig` / `runOptions` / `resumeState` keys become explicit parameters
or are deleted with a note — decide per key, do not carry them forward as an untyped bag.

---

## Slice sequence

Each slice is its own worktree branch, merged `--no-ff`, per `AGENTS.md`. Slices 1–2 are
deletions and can land immediately; 3 is the enabling change; 4–6 depend on 3.

### Slice 1 — delete dead exports

Delete `applyPatchTool`. Confirm zero references first (`agent-factory.ts:169` is a log string,
`apply-patch.test.ts:165` is commented out).

*Verify:* `tsc --noEmit`; focused `agent-factory` tests.

### Slice 2 — delete `run()`, `Runner`, `adaptLegacyModel`; make a provider runner mandatory

`run()` only throws, so every call site that reaches it is already a failure path. Remove the
`providerId === 'openai'` special case in `edit-healing.ts:164` and `utils.ts:68-76`: every
registered provider now gets a `createRunner` synthesized from `createStreamedModel`
(`registry.ts:102-105`), including OpenAI (`openai.provider.ts:99`). A missing runner becomes a
thrown configuration error, not a silent fallback.

Fix F3/F4 in the same slice, since they are the same mistake: `createApplicationCompatibilityRunner.run`
returns an unsettled `AgentStream`. Either await `completed` inside it, or make the two
result-shaped callers (`edit-healing.ts:206`, `mentor-runner.ts:174`) await the stream. Prefer
the former — `LegacyRunner.run` is also used by the streaming main path
(`agent-run-orchestrator.ts:533`), so introduce a separate `runToCompletion` rather than
changing `run`'s contract under the main path.

`Runner` dies with it: `nested-runner.ts:266` reads only `.config`, which feeds `runConfig`,
which `asTool` ignores. `adaptLegacyModel` has no consumer once `Runner.run` is gone; delete
`legacy-compat.test.ts` with it.

*Verify:* new regression that edit healing returns model text on both OpenAI and a non-OpenAI
provider (currently impossible — this is the F3 pin). Mentor final-text regression for F4.
Focused: `edit-healing`, `mentor-runner`, `subagents/utils`, `registry`.

### Slice 3 — `ToolInvocationContext` in `ApplicationRunLoop`

Add the context slot and `ApprovalLedger`, thread through `#handleToolCall`,
`#invokeTool`, `needsApproval`, and continuation state.

*Verify:* loop-level tests that a tool's `context.context` is the object passed in
`startStream` options, and that it survives `continueRunStream` across an approval pause.
This is the F2 pin; assert it at the loop, not through a subagent.

### Slice 4 — `Agent` → `ApplicationAgent` literals

Four production sites (`execution-runner.ts:187`, `mentor-runner.ts:145`,
`nested-runner.ts:249`, `edit-healing.ts:179`) plus test importers. Mechanical once slice 3
lands, but do it after 3 so the tests written in 3 catch context regressions.

*Verify:* `tsc --noEmit`; focused `execution-runner`, `mentor-runner`, `agent-factory`,
`agents-model-bridge` tests.

### Slice 5 — `RunContext` → `ApprovalLedger` + typed parent replay

Replace `new RunContext(runContext)` at `nested-runner.ts:384`, and `readParentApprovals`'
structural probe with `ledger.snapshot()`. Change `tool-policy.ts`'s `RunContext<unknown>`
parameter types to `ToolInvocationContext<unknown>`.

*Verify:* the F5 pin — a tool approved in the parent does not prompt again inside a nested
subagent. `approval-replay.test.ts` must keep passing unchanged; if it needs editing, the
ledger's semantics drifted.

### Slice 6 — `tool()` / `Tool` → `ToolDefinition`, and `createSubagentTool()`

`tool-policy.ts:958-1015` `buildAgentTools` returns `ToolDefinition[]`; `wrapToolInvoke`
(`lib/tool-invoke.ts:353`) is adapted to wrap `execute` rather than requiring
`type: 'function'` + `invoke`. Keep its input normalization and schema diagnostics — that is
the only load-bearing thing `tool()` did.

Then replace `asTool` with `createSubagentTool()` per piece 4 above (fixes F1).

*Verify:* new `nested-runner.test.ts` coverage that actually drives `NestedSubagentRunner`
end to end — a nested role tool that runs, executes a tool, and returns a parseable
`SubagentResult` with `filesChanged` and `toolsUsed` populated. `tool-policy.test.ts`,
`subagent-manager.*` suites.

### Slice 7 — delete the file

`legacy-compat.ts` and its test are gone; `grep -rn "legacy-compat" source/` returns nothing.
Update the parent plan: remove § *`legacy-compat.ts` is a shim, not a finished slice* and record
the result.

*Verify:* full `tsc --noEmit` and full Vitest against the baseline recorded in the parent plan
(4,813 passed / 1 skipped, sandbox host test excepted).

---

## Non-goals

- **Do not touch `contracts/model.ts`'s `LegacyRunner` / `LegacyModel` in this plan.** They are
  consumed by the main streaming path (`runner-manager.ts`, `agent-run-orchestrator.ts`,
  `agent-chat-service.ts`) and by `providers/agents-model-bridge.ts`, which is still routed by
  three AI SDK providers. That is a separate slice of the parent plan.
- **Do not extend `ApplicationRunLoop` beyond the context slot.** No handoffs, no tracing, no
  `callModelInputFilter`. `incrementSubagentTurnCount` (`nested-runner.ts:45`) and the mentor's
  equivalent (`mentor-runner.ts:165`) currently run under no filter at all; if turn counting
  matters, count turns in the loop, do not re-introduce a filter hook.
- **Do not preserve `runConfig` / `resumeState` / `runOptions` as untyped bags.** They are
  currently dropped on the floor. Each is either an explicit parameter or a deletion.

## Open question

Slice 2 fixes F3/F4 by settling the stream. Whether `runToCompletion` should also surface
interruptions (an approval raised inside edit healing or the mentor) is undecided — today both
paths run tool-less agents, so it cannot arise. Decide when a tool-bearing caller appears; do
not speculatively build it.
