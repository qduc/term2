# Decoupling from `@openai/agents`

**Status:** Step A mostly done — A1, A2, A3 and the R1 gate landed on `main`. Resolve the composition root before A4.
**Last updated:** 2026-07-27

---

## Resume here

Read this section first, then *Corrections*, then *The risk register*. The risk register is
the measure of progress — reach-ins retired, **not** lines deleted. The original plan argued
from LOC and from a capability claim that turned out to be false; don't re-derive either.

### Landed on `main`

| Work | Result |
|---|---|
| A1 | Dead `removeInterceptor` plumbing deleted (was always `noop`) |
| A2 | `_pendingAgentToolRuns` retired behind `services/approval/tool-ownership-registry.ts` |
| A3 | `_mergeApprovals` retired via `services/approval/approval-replay.ts` — **2 of 9 reach-ins done** |
| R1 | Resume-after-approval preserves `details.toolCall.callId`; pinned by `source/lib/sdk-approval-resume.test.ts` |
| Bug fix | Denied-read approval never fired for `cd`-prefixed commands (record/lookup key mismatch) |
| Bug fix | Docker host-control denials leaked across sessions (process-global `#deniedCommands`) |

Each landed as a `--no-ff` merge from its own worktree branch; branch history is preserved.

### In flight

Nothing. No worktrees or agent branches outstanding.

### `ApprovalRecord` semantics, established by reading the SDK source

Recorded because the plan previously only guessed at this, and getting it wrong over-grants
approvals across the parent/subagent boundary **silently**. From
`node_modules/@openai/agents-core/dist/runContext.js` (`approveTool`, `rejectTool`,
`isToolApproved`, `#setApprovalRecord`, `#getApprovalStorageKey`):

- **Keys are tool names, not call ids.** (`computer` / `computer_use_preview` share one key.)
  The repo's old `nested-runner.test.ts` used a call-id key and encoded the wrong model.
- **`approved: true`** = blanket; `isToolApproved` returns `true` for *any* call id.
- **`approved: string[]`** = exactly those call ids; anything else returns `undefined`
  (still prompt).
- **`approved: false`** carries no decision — it is residue from
  `rejectTool(…, { alwaysReject: true })`.
- **Precedence:** blanket approval outranks blanket rejection.

Consequence for `approval-replay.ts`: **rejections are replayed before approvals**, because
`approveTool(…, { alwaysApprove: true })` resets `rejected` and vice versa, so ordering decides
which survives a record holding both.

**Known fidelity limit:** a record that is blanket-rejected *and* carries per-call rejection
messages keeps only `stickyRejectMessage`; the public API cannot express both. Message text
only — every such call is rejected either way. Moot here: this repo never calls
`getRejectionMessage`, `alwaysApprove`, or `alwaysReject`, and only does per-call
`state.approve` / `state.reject` at `approval-flow-coordinator.ts:270,288`.

### Next, in order

1. **Solve the composition-root problem once.** `agentClient` is constructed before
   `session-composition` runs, so there is no common root for per-session injection. This
   already forced A2 into a module-scoped registry, and A4's `SessionSandboxState` will hit
   the identical wall. The repo has five such singletons already (`deniedReadStore`,
   `executionOverrideStore`, `sessionReadAccess`, the docker grants, the new registry) —
   don't add a sixth by default.
2. **A4** — absorb the approval side-channels into the pending call. Full design was produced
   separately; its staged sequence is Stage 0-7 with the risky stages being the delivery seam,
   the batch path in `tool-approval-batch-coordinator.ts` (which retargets one shared pending
   context across siblings — reusing an object there reintroduces the exact
   cross-contamination bug being fixed), and docker.

### R1 gate — PASSED

`source/lib/sdk-approval-resume.test.ts` uses a real SDK `Runner` and a serialized/restored
`RunState`: it interrupts for a function-tool approval, approves the restored interruption,
resumes the run, and asserts that the tool receives the original call id through
`details.toolCall.callId`. The carrier assumed by A4 is therefore available on the risky
resume path; mocks do not supply the execution details in this test.

### Deliberately left open

A concurrency bug: `maxParallelToolCalls` defaults to 3 (`agent-run-orchestrator.ts:61-68`)
while `ExecutionOverrideStore` is command-keyed with a consuming read, so two concurrent
identical `shell` calls can cross-contaminate grants — one executes with permissions the user
granted to a different call. **Do not write a stopgap.** A4's callId keying fixes it
structurally and the stopgap would be thrown away.

---

## Goal

Reach **zero `@openai/agents*` imports**, including the Codex WS transport, replacing the
SDK with our own run loop and domain types.

**The driver is fragility, not capability or LOC reduction.** We reach into SDK *private*
API in 9 places across 8 non-test files. `@openai/agents` is a `0.x` package with no semver
protection, and `tool-owner.ts` already carries three `logger.warn` branches for when those
private shapes don't match — the code anticipates drift. That is the risk being retired.

This supersedes the original framing (mediation-tax LOC reduction, plus "serializable
mid-turn state" as a new capability). Both survived contact with the code only partially;
see *Corrections* below.

## The risk register

The actual thing being eliminated. Every entry is a private-API reach-in.

| Reach-in | Files | Layer | Retired in |
|---|---|---|---|
| ~~`_pendingAgentToolRuns`~~ | ~~`services/approval/tool-owner.ts`~~ | approval | **DONE** (A2) |
| ~~`_mergeApprovals`~~ | ~~`services/subagents/nested-runner.ts`~~ | approval | **DONE** (A3) |
| `_generatedItems` | `services/stream-snapshot.ts`, `services/session/session-tool-tracker.ts`, `services/session/continuation-call-id-resolver.ts` | run loop | Step C/E |
| `_buildResponsesCreateRequest` | `providers/codex-responses-model.ts`, `providers/fallback-responses-model.ts`, `providers/openai.provider.ts` | provider | Step D/E |
| `_fetchResponse` | `providers/codex-responses-model.ts` | provider | Step E |

Progress on this table is the measure of the project. LOC deleted is not.

---

## Corrections to the original investigation

These are load-bearing. The original doc argued from them.

### 1. "Serializable mid-turn state is a feature we cannot build today" — **false**

The doc claimed `RunState` is memory-only, so a pending approval cannot survive a restart.
`RunState` exposes `toString()` and `static fromString()` / `fromStringWithContext()`
(`runState.d.ts:2875,2884`) — the SDK's documented human-in-the-loop persistence API.
`toJSON` even documents *"rehydrate in a separate process that lacks the original
environment variables."* **We call none of them** (zero hits in `source/`).

The real blocker is ours, not the SDK's: the approve→execute handoff bypasses run state
entirely. `ExecutionOverrideStore` (`utils/shell/sandbox/denied-read-stores.ts:74-93`) is an
in-memory `Map` keyed by *normalized command string*, documented as *"Set at
approval-decision time; consumed and cleared by `execute` when the SDK resumes the approved
tool call."* Alongside it: `DeniedReadStore` (:26), `allowReadFolderForSession`
(`approval-flow-coordinator.ts:160`), and session-scoped docker grants (:217).

A turn serialized and resumed in a fresh process finds these maps empty, and either
re-prompts or executes with different sandbox permissions than the user approved.

**Consequence:** durable approvals are achievable today and the decoupling neither enables
nor requires them. They are a separate piece of work, unblocked by fixing the side-channels.

### 2. The mediation-tax table overstates deletions

Spot-audited one row. `input-surge-guard.ts` is not just an SDK watchdog — it is a
user-facing preflight feature. `bypassInputSurgeGuard` threads through
`hooks/use-conversation.ts:216`, `conversation-orchestrator.ts:373`,
`conversation-adapter.ts`; `queue-controller.ts:7` declares
`PreflightKind = 'input_surge' | 'large_uncached_input'`; `use-pending-turn-guards.ts:87-126`
gates every turn and shows an approve/decline prompt.

What dies is the duplicate-pair *heuristic* (~100 LOC). What survives is the preflight
*gate* across ~7 files, sitting beside `large_uncached_input`, a cost-control feature with
no SDK involvement.

The remaining 11 rows were **not** audited — the LOC figure stopped being decision-relevant
once fragility became the driver. Treat ~2–3k LOC as unverified.

### 3. Both approval reach-ins are escapable without decoupling

- `_mergeApprovals`: `ApprovalRecord.approved` is `boolean | string[]`
  (`runContext.d.ts:4-9`), mapping directly onto public
  `approveTool(item, { alwaysApprove })` / `rejectTool(item, { alwaysReject, message })`.
  Parent approvals can be replayed into the nested context via public API.
- `_pendingAgentToolRuns`: `nested-runner.ts` creates the nested run and already knows
  `agentId` and `role`. Tracking `callId → owner` ourselves deletes all 80 lines of
  `tool-owner.ts` archaeology and its three drift warnings.

Step A therefore delivers real risk reduction on its own, days not weeks, and is abandonable
with the codebase strictly better.

### 4. Chaining is a minority path taxing everything

Only **2 providers** declare `supportsConversationChaining: true` — `openai.provider.ts:155`
and `codex.provider.ts:623`. `openai-compatible`, `openrouter`, `openai-compatible-lazy` and
all ai-sdk providers declare `false`.

That minority imposes on all paths: a `delta | full_history` input mode across 13 non-test
files, 99 `previousResponseId` references in 24 files, `chained-input-filter.ts` (222) +
`chained-wire-state.ts` (228), and the transport-downgrade recovery machinery.

Critically, **chaining is the root cause of the `_generatedItems` reach-ins.**
`session-tool-tracker.ts:159-173`: *"In chaining/delta mode the conversation store never
receives `function_call_output` items… They live transiently in the SDK RunState's
`_generatedItems`."*

Asymmetry: for `openai` chaining is a pure optimization. For `codex` it is load-bearing —
`agent-factory.ts:254-256` sets `store = false`, yet `codex-responses-model.ts` threads
`previousResponseId` through ~20 sites including a remembered-response-id cache and
consumed-tool-result tracking (`:590,596,711`). The WS transport holds server state outside
the normal `store` flag.

### 5. Two smaller findings, actionable now

- **`removeInterceptor` is already dead.** Both producers assign `noop`
  (`approval-flow-coordinator.ts:125,302`). It is threaded through 5 files for nothing.
  Deletable today, independent of this project.
- **`GenerationToken` is `number`** (`generation-guard.ts:1`), a process-local counter.
  Persisting it is worse than useless — after restart the guard resets to 0 and a stale
  token can spuriously satisfy `isCurrent`. Durable turns need an epoch/session identity.

---

## Decisions taken

| Question | Decision |
|---|---|
| Driver | Fragility — private-API dependence. Not LOC, not capability. |
| Durable mid-turn approvals | Design for it (plain-data, serializable turns); ship later. |
| Approval type scope | **Absorbs the side-channels.** The pending call carries its own execution override (`extraAllowRead`, `forceUnsandboxed`, denied-read metadata) as data. Kills command-string keying; approve→execute becomes a pure function of the turn. |
| Chaining | **Keep the dual mode as-is for now.** Not touched in Steps A–D. |
| Endpoint | Zero SDK imports, **codex included**. |

### Known interlock — must be resolved before Step E

Keeping the dual mode while removing the SDK from the codex provider is close to
contradictory: `_generatedItems` recovery exists to serve chaining, and codex is the one
provider where chaining is load-bearing. Step E cannot start until chaining is dispositioned.

The option not taken, recorded because it is the likely resolution: **confine chaining to
the provider layer** — domain model always carries full history, codex's model keeps
`previousResponseId` internally as a wire detail it manages itself. That removes the
`delta | full_history` axis and the `_generatedItems` reach-ins without rewriting the
transport. The dual mode is the leak; chaining itself is not.

---

## Sequencing (fragility-first)

Re-ordered from the original types-first plan. Each step retires named reach-ins.

### Step A — Approval layer (days)

- **A1 — DONE.** `removeInterceptor` dead plumbing deleted (was always `noop`).
- **A2 — DONE.** `_pendingAgentToolRuns` retired via a `ToolOwnershipRegistry` that claims
  `callId → owner` at nested-run creation. **1 of 9 reach-ins retired.**
  *Correction:* `tool-owner.ts` was **not** deleted — it went 81 → 14 lines. `ToolOwner` and
  `PARENT_TOOL_OWNER` are consumed by `approval-state.ts` and approval event shaping; only
  the 67 lines of SDK archaeology and its three drift warnings died.
- **A3 — DONE.** Replaced our `_mergeApprovals` call at initial nested-run creation with
  public `approveTool`/`rejectTool` replay in `approval-replay.ts`.
  *Note:* the SDK also calls `_mergeApprovals` itself at `agent.js:259` on the **resume**
  path, gated by `resumeContextStrategy === 'merge'` (set at `nested-runner.ts:268`). That
  is the library's own internal use reached through a *public* option, not our reach-in.
  A3 retires ours; the SDK's goes away with the SDK.
- **A4.** Absorb `ExecutionOverrideStore` / `DeniedReadStore` / session grants into the
  pending call. R1 passed; resolve the composition root before implementation.

**Live bugs found during this work** (independent of decoupling; the command-string keying
that A4 removes was actively broken):

- **FIXED** — denied-read approval never fired for `cd`-prefixed commands. `shell.ts` recorded
  under `optimizedCommand` (post-`stripRedundantCd`) while both lookups used the raw
  model-emitted command. Six of seven store call sites already used raw; `record` was the sole
  outlier. The Docker branch ten lines above already had the correct reasoning in a comment.
- **OPEN, rides with A4** — concurrent identical commands cross-contaminate grants.
  `maxParallelToolCalls` defaults to 3 (`agent-run-orchestrator.ts:61-68`) and
  `ExecutionOverrideStore` is command-keyed with a consuming read, so one call can execute
  with permissions the user granted to a different call. Fixed structurally by callId keying.
- **FIXED** — `#deniedCommands` was process-global with no sessionId and never cleared
  per-session, so one session's blocked docker command forced an approval prompt in every
  other session, permanently. Now `#deniedBySession`, mirroring `#onceBySession`.
  Fail-closed: a run with no session identity drops the record rather than storing it
  globally, so the command stays sandboxed instead of gaining unearned host access.
  `ApprovalPrompt.tsx` has no session identity and cannot consult the store, so the
  producer now resolves it onto `ApprovalDescriptor.dockerHostControl` — which converges
  with A4's proposed `{ variant: 'docker_host_control' }` prompt variant.

**Known follow-up:** `AbortResolutionPlan` is now a single-field passthrough no production
caller reads — `ContinuationPlanApplier` calls `prepareAbortResolution` purely for its
`state.reject` side effect. Deletable.

**Undocumented SDK behavior worth recording:** `customOutputExtractor` runs unconditionally,
interruptions included (`agent.js:307-322`, before `saveAgentToolRunResult` at `:342`).
A2's claim-at-source design depends on this ordering.

### Step B — Canonical types + normalize at the boundary
`source/contracts/`: `Item`, `Turn`, `ToolCall`, `Approval`. One adapter, SDK items → ours.
`rawItem` leaves 39 files while still on the SDK. Note `contracts/conversation.ts:1` already
imports `ModelSettingsReasoningEffort` from the SDK — the contracts layer is not currently
SDK-free.
**Retires 0 reach-ins directly; contains them and collapses blast radius.**

### Step C — Own the run loop
Contained, because downstream already speaks our language.
**Retires `_generatedItems` in `stream-snapshot.ts` / `continuation-call-id-resolver.ts`.**

### Step D — Non-codex providers off the SDK
Delete `ai-sdk-agents-adapter.ts` (112); ai-sdk providers implement our interface directly.
Removes `@openai/agents-extensions`. `ai` and `@ai-sdk/*` are already dependencies.
**Retires `_buildResponsesCreateRequest` in `openai.provider.ts` / `fallback-responses-model.ts`.**

### Step E — Chaining disposition, then the Codex WS transport
The irreducible risk. Resolve the interlock first. Driven by the existing
`codex-responses-model.test.ts` (2456 lines) and `fallback-responses-model.test.ts` (1356) —
that is hard-won production knowledge and effectively the spec. **Port those assertions first
and let them drive the implementation. Do not discard them.**
Related groundwork: `luna-responses-lite-wire-protocol.ts` (112),
`websocket-receive-watchdog.ts` (95).
**Retires the remaining reach-ins.**

---

## Scale of coupling (verified 2026-07-27)

- **53 non-test source files** import `@openai/agents*`; 85 including tests.
- **197 non-test `rawItem` sites**; 380 including tests.
- **99 non-test `previousResponseId` references** across 24 files.
- Out of 788 TS files total. Installed: `@openai/agents-core` **0.11.4**.

Three clusters: `source/providers/` (~7k LOC incl. tests); the run + approval loop
(`lib/agent-*`, `services/session/`, `services/approval/`, `services/retry/`); and type-only
`AgentInputItem` usage (19 files) across conversation/persistence/logging.

**Not used at all:** handoffs (the `handoff` hits in `source/hooks/` are our own unrelated UI
feature), guardrails, MCP, sessions/memory, voice, realtime.

**Minor dependencies:** `applyDiff` / `applyPatchTool` (native patch for gpt-5.1), the
`tool()` factory, `ModelBehaviorError`, tracing (`withTrace` — mostly we *disable* it),
`ModelSettingsReasoningEffort` (a string union).

## Open questions

- Shape of `Item`, `Turn`, `ToolCall`, `Approval` (Step B) — now constrained by the Step A
  decision that `Approval` carries its own execution override.
- Whether to keep a `Model`-shaped interface at all, or expose something closer to what `ai`
  already gives us (Step D).
- Chaining disposition (blocks Step E).
- Audit the remaining 11 mediation-tax rows — only if LOC becomes decision-relevant again.

## Key file references

- `source/lib/agent-run-orchestrator.ts` (335) — run/stream lifecycle
- `source/lib/agent-factory.ts` (351) — agent + tool construction; codex `store=false` at :254
- `source/lib/agent-client.ts` (328)
- `source/lib/tool-invoke.ts` (502)
- `source/lib/chained-input-filter.ts` (222)
- `source/services/approval/approval-state.ts` (102) — `RunState` held in memory
- `source/services/approval/approval-flow-coordinator.ts` — approve/reject
- `source/services/approval/tool-owner.ts` (81) — Step A deletion target
- `source/services/provider-continuity.ts` (36) — chaining state
- `source/services/session/session-input-planner.ts` (273) — chaining decision point
- `source/services/session/session-stream-processor.ts` (287)
- `source/services/stream-event-processor.ts` (503)
- `source/services/subagents/nested-runner.ts` (395) — private-API `_mergeApprovals`
- `source/providers/codex-responses-model.ts` (1204) — SDK subclassing
- `source/providers/fallback-responses-model.ts` (344)
- `source/providers/ai-sdk-agents-adapter.ts` (112) — Step D deletion target
- `source/services/conversation/conversation-replay.ts` (1192)
