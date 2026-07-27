# Decoupling from `@openai/agents`

**Status:** Step A is complete through A4 tool ownership, the first bounded Step B representation slice is landed, and Step C has retired `_generatedItems` from continuation call-ID resolution and replay diagnostics. The transport-failure recovery read remains; CallId-only migration of denied-read metadata/overrides is still blocked under the stock SDK.
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
| A4 groundwork | Session factory owns/disposes the closure-bound client; reset and both CLI modes replace the handle |
| A4 tool ownership | `ToolOwnershipRegistry` is created by each session handle and explicitly propagated through root clients, session runtime composition, approval flow, subagent bridge/manager/runtime, and nested runners; no process singleton/default remains |
| A4 retry proof | A real SDK `Runner` proves a denied-read-like output from call A can cause the model to emit the same shell arguments as a new call B; B is not correlated to A by call id |
| Step B representation slice | `contracts/conversation-items.ts` owns canonical `Item`, `Turn`, `ToolCall`, and related serializable shapes; `Approval` aliases `ApprovalDescriptor`; legacy persisted names alias those contracts; `run-item-normalizer.ts` contains raw SDK/provider item normalization while replay remains provider-facing |
| Step C continuation IDs | `continuation-call-id-resolver.ts` uses public interruption IDs plus current-turn completed IDs from the session ledger; it no longer reads `_generatedItems` |
| Step C replay diagnostics | Duplicate-tool replay diagnostics inspect public `history` / `newItems`; `stream-snapshot.ts` no longer reads `_generatedItems` |
| Bug fix | Denied-read approval never fired for `cd`-prefixed commands (record/lookup key mismatch) |
| Bug fix | Docker host-control denials leaked across sessions (process-global `#deniedCommands`) |

Each landed as a `--no-ff` merge from its own worktree branch; branch history is preserved.

### In flight

The next Step C slice is the remaining transport-failure recovery read in
`SessionToolTracker.recoverApprovedResultsFromState()`. Prove whether all required outputs are
observable from public stream events/collections before changing it; do not merely relocate the
private read. Do not migrate denied-read metadata or execution overrides until Step C owns a
post-execute pause/resume seam.

### A4 tool-ownership lifecycle

`createOwnedSessionClientFactory()` creates one fresh `ToolOwnershipRegistry` per session handle
and gives that exact instance to the root `AgentClient`. The handle exposes it to
`createConversationRuntime()`, which passes it to `ApprovalFlowCoordinator`; `AgentClient` passes
the same instance through its `SubagentBridge`, `SubagentManager`, subagent runtime, execution
runner, and nested runner. Thus a nested call can be claimed and later resolved by the approval
flow without a process-global registry. Caller-owned client seams explicitly receive a registry.
On reset, `ConversationService` disposes the old handle and creates a new one, so its registry is
not reused; disposal clears the registry along with the old session epoch.

Test fixtures now explicitly create fresh registries, sharing one only when a fixture exercises
the parent/nested ownership relationship. This keeps test identity/lifecycle aligned with the
production session contract.

### Validation at pause

- Step B's focused normalizer, turn-item compatibility, turn accumulator, stream, replay,
  state projector, tool-ledger, and chained-filter set passes: 6 files / 108 tests.
- `source/lib/sdk-approval-resume.test.ts` passes its real-Runner approval-resume and
  denied-read model-retry regressions. The latter observes call A at execute, then a distinct
  call B at `needsApproval`, where B interrupts before execute.
- Full `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Continuation-call-id resolver slice: resolver, ledger, tracker, TurnWorkflow parity, and
  approval-batch tests pass (5 files / 50 tests). `tsc --noEmit` again reaches only the known
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Replay-diagnostics slice: conversation stream and stream-processor tests pass (2 files / 27
  tests); diagnostics retain public history/new-item duplicate detection and drop private-state
  metadata.
- Focused tool-ownership clusters pass: 23 files / 364 tests, plus the 4-test conversation
  integration fixture. Formatting and lint pass except the pre-existing `prefer-const` warning
  in `services/subagents/runtime.ts`.
- After building `dist/`, full Vitest reaches 4,566 passing / 1 skipped / 1 failing. The sole
  failure is the pre-existing sandbox terminal E2E failure in `source/cli.e2e.test.ts` (the child
  terminal exits before rendering `Lite`); it reproduces on the baseline checkout.
- No dependency installation was run; this worktree uses its existing `node_modules` symlink.

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

1. **Step C** — own the post-execute pause/resume seam in the run loop before migrating
   denied-read metadata or execution overrides. The completed Step B representation slice
   contains raw-item normalization but does not retire SDK reach-ins or change run behavior.

### R1 gate — PASSED

`source/lib/sdk-approval-resume.test.ts` uses a real SDK `Runner` and a serialized/restored
`RunState`: it interrupts for a function-tool approval, approves the restored interruption,
resumes the run, and asserts that the tool receives the original call id through
`details.toolCall.callId`. The carrier assumed by A4 is therefore available on the risky
resume path; mocks do not supply the execution details in this test.

This applies only to **approval resume**: the SDK pauses before execute and resumes that same
tool call, so its call id remains stable. A distinct real-Runner regression in the same file
also proves the different **model retry** path: execute receives call A and returns an ordinary
denied-read-like function output; after seeing that output the model emits identical shell
arguments under call B. `needsApproval` receives A then B, and B interrupts before execute.
Call B has an unrelated call id, so callId alone cannot bridge denied-read discovery to that
future retry under the stock SDK.

### Composition-root decision — client and runtime share one session handle

`session-composition.ts` remains the session composition root. The interactive and
non-interactive entry points will provide long-lived application dependencies to one session
factory; they will no longer independently construct the closure-bound `AgentClient`.

The factory creates one session handle containing the runtime, approval coordinator,
session-bound root client and nested clients, read-access state, transient docker state, and a
session-owned tool-call ledger. `ConversationService.resetWithNewId()` must dispose that whole
handle and ask the factory for a replacement. It must not clear and reuse state captured by the
old client: late callbacks from the disposed session must be unable to mutate the replacement.
Persistent project-level docker grants remain settings-backed and outside the handle.

The call ledger is not a generic `SessionSandboxState` service locator. Its landed narrow
capability owns tool ownership keyed by `callId`. Denied-read metadata and execution overrides
are intentionally not added yet: their discovery is post-execute, while a model retry is a new
call id. The SDK-specific extraction stays at the tool boundary; approval services receive a
domain call id. R1 proves that identity only for serialized approval resume.

**Implemented groundwork:** `session-client-factory.ts` now creates an owned client handle;
`ConversationService` owns that handle beside the runtime and replaces both on
`resetWithNewId()`. Interactive and non-interactive CLI paths use the same factory, while the
prebuilt-client seam remains caller-owned for compatibility tests. `AgentClient`, its settings
subscription, and its subagent bridge have idempotent disposal. This establishes the common
lifetime into which the call ledger can now be injected.

Required invariants:

- duplicate active call ids in one session fail closed rather than overwrite;
- approval resume and execution correlate by call id; a post-execute model retry requires a
  Step C run-loop seam rather than call-id correlation or command matching;
- parent and nested agents share the ledger but retain distinct tool owners;
- records are removed on success, denial, failure, cancellation, and session disposal;
- reset replaces the session epoch, so reused call ids and late callbacks cannot cross sessions;
- session read access and transient docker grants die with the handle; project grants survive;
- no module-global current-session accessor, `AsyncLocalStorage` workaround, or fallback store.

Migration order:

1. **DONE.** Add disposal support for the closure-bound client (including settings
   subscriptions), then introduce a session client factory/handle while retaining compatibility
   seams for tests.
2. **DONE.** Route both CLI modes and `resetWithNewId()` through that factory; prove replacement
   and disposal before moving policy state.
3. **DONE.** Introduce the session-owned call ledger and migrate tool ownership.
4. **STOPPED:** do not expand the ledger to denied-read metadata or execution overrides under
   the stock SDK. Call A's denied result causes a newly emitted retry call B, so callId-only A4
   has no bridge. Reject both command-key fallback and a temporary token protocol for now;
   retain current behavior. Defer this migration until Step C owns a post-execute pause/resume
   seam, then add the concurrent-identical-command regression.
5. Move session read access and transient docker state into the handle, keeping project grants
   persistent; bind nested client caches to handle disposal.
6. Delete singleton fallbacks and compatibility wiring after all production roots inject the
   session-owned capabilities.

### Deliberately left open

A concurrency bug remains: `maxParallelToolCalls` defaults to 3
(`agent-run-orchestrator.ts:61-68`) while `ExecutionOverrideStore` is command-keyed with a
consuming read, so two concurrent identical `shell` calls can cross-contaminate grants — one
executes with permissions the user granted to a different call. **Do not write a stopgap.**
CallId-only A4 cannot fix this under the stock SDK's model-retry behavior; Step C must provide
the post-execute pause/resume seam before this migration can be made safely.

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
| `_generatedItems` | ~~`services/stream-snapshot.ts`~~, `services/session/session-tool-tracker.ts`, ~~`services/session/continuation-call-id-resolver.ts`~~ | run loop | **Resolver + replay diagnostics DONE**; tracker recovery remains Step C/E |
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
| Approval type scope | Step B defines the types, but does **not** absorb denied-read side-channels yet. The stock SDK emits a new call id on model retry after execute, so callId-only A4 is blocked. Reject command fallback and a temporary token protocol; Step C will own a post-execute pause/resume seam before migrating overrides. |
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
- **A4 — PARTIAL / BLOCKED.** Session-owned tool ownership is landed. R1 remains valid for an
  approval resume of the same call id, but it does not apply to a model retry after execute.
  The real-Runner denied-read regression proves that retry is a new call id, so do not migrate
  `ExecutionOverrideStore` / `DeniedReadStore` / session grants by call id under the stock SDK.
  Reject command fallback and a temporary token protocol; defer this work to Step C's
  post-execute pause/resume seam while keeping current behavior unchanged.

**Live bugs found during this work** (independent of decoupling; the command-string keying is
actively broken and remains until Step C can replace it safely):

- **FIXED** — denied-read approval never fired for `cd`-prefixed commands. `shell.ts` recorded
  under `optimizedCommand` (post-`stripRedundantCd`) while both lookups used the raw
  model-emitted command. Six of seven store call sites already used raw; `record` was the sole
  outlier. The Docker branch ten lines above already had the correct reasoning in a comment.
- **OPEN, deferred to Step C** — concurrent identical commands cross-contaminate grants.
  `maxParallelToolCalls` defaults to 3 (`agent-run-orchestrator.ts:61-68`) and
  `ExecutionOverrideStore` is command-keyed with a consuming read, so one call can execute
  with permissions the user granted to a different call. CallId-only A4 cannot fix this because
   a denied-read model retry receives a new id; Step C needs a post-execute pause/resume seam.
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

**Next implementation step.** Keep current denied-read recovery behavior unchanged. Do not add
command matching or a temporary token protocol; Step C must first own the post-execute
pause/resume seam needed to migrate denied-read metadata and execution overrides safely.

**Landed representation slice.** `source/contracts/conversation-items.ts` now owns the canonical
serializable item and turn shapes; compatibility aliases in `conversation-persistence-types.ts`
preserve existing persisted imports. `Approval` reuses `ApprovalDescriptor`, and
`ReasoningEffortSetting` is the app-supported string union instead of an SDK import.
`run-item-normalizer.ts` owns the raw-item-to-`Item[]` adapter, while
`conversation-turn-items.ts` delegates its legacy builders and retains provider-facing replay.
This contains normalization only: it does not remove SDK reach-ins, migrate all raw items, or
alter requests, RunState, chaining, approval/resume, denied-read, execution overrides, or run-loop behavior.

### Step C — Own the run loop
Contained, because downstream already speaks our language.
**Resolver + replay-diagnostics slices DONE:** `continuation-call-id-resolver.ts` uses public
interruption IDs and current-turn completed IDs from the session ledger. `stream-snapshot.ts`
uses only public stream history/new items for duplicate-tool diagnostics. Only
`SessionToolTracker.recoverApprovedResultsFromState()` still reads `_generatedItems`, for its
transport-failure recovery responsibility; retire it only after proving a complete public source.

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

- Shape of `Item`, `Turn`, `ToolCall`, `Approval` (Step B) — do not prematurely encode the
  denied-read execution override; Step C must establish its post-execute pause/resume seam.
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
