# Decoupling from `@openai/agents`

**Status:** Step A is complete through the bounded A4 root fallback cleanup, Step B's bounded representation migration is complete, and Step C has retired every production `_generatedItems` read. Three of the five private-API categories in the risk register are retired. The two remaining categories are provider-side `_buildResponsesCreateRequest` and `_fetchResponse` coupling in Steps D/E. Step D's adapter characterization, application-owned one-streamed-turn contract/Agents bridge, unrouted AI SDK implementation, and OpenRouter, Google, and Anthropic routing slices are landed; the now-unreferenced legacy adapter, its characterization test, and direct `@openai/agents-extensions` dependency are retired. Focused routed-provider, direct-turn, bridge, custom-provider, and message-normalizer validation passes. The application-owned post-execute seam carries root denied-read metadata and call-isolated one-shot overrides through the same held tool call and live stream; nested tools retain their compatibility path. **Step E's chaining disposition, Stage 0 characterization/instrumentation, bounded Stage 1 OpenAI parity/handoff, bounded fresh-session OpenAI provider projection switch, and request/response correlation prerequisite are landed:** full provider-facing history remains the application’s semantic record, while OpenAI/Codex continuation remains a provider-private compatibility projection. Newly created OpenAI session clients select the parity-proven projection through a frozen session-lifetime compatibility mode; legacy clients and Codex remain on the established baseline. OpenAI-private HTTP/WebSocket observations pair an opaque public-call token, exact built request data, and normalized terminal response ID. Production candidate observation remains blocked by truthful account identity and exact snapshot-prefix binding into the provider token; no reach-in is retired.
**Last updated:** 2026-07-29

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
| A3 | `_mergeApprovals` retired via `services/approval/approval-replay.ts` |
| R1 | Resume-after-approval preserves `details.toolCall.callId`; pinned by `source/lib/sdk-approval-resume.test.ts` |
| A4 groundwork | Session factory owns/disposes the closure-bound client; reset and both CLI modes replace the handle |
| A4 tool ownership | `ToolOwnershipRegistry` is created by each session handle and explicitly propagated through root clients, session runtime composition, approval flow, subagent bridge/manager/runtime, and nested runners; no process singleton/default remains |
| A4 lifecycle follow-up | Each owned handle now creates/disposes its root read/Docker access capability; project Docker grants remain settings-backed, and transient execution subclients dispose after state transfer |
| A4 nested/test compatibility retirement | Root tools and approval/result/lifecycle paths no longer fall back to session-id or command-keyed stores; nested tools receive a fresh explicit `NestedToolCompatibilityState` and never receive root post-execute state |
| A4 retry proof | A real SDK `Runner` proves a denied-read-like output from call A can cause the model to emit the same shell arguments as a new call B; B is not correlated to A by call id |
| Step B representation slice | `contracts/conversation-items.ts` owns canonical `Item`, `Turn`, `ToolCall`, and related serializable shapes; `Approval` aliases `ApprovalDescriptor`; legacy persisted names alias those contracts; `run-item-normalizer.ts` contains raw SDK/provider item normalization while replay remains provider-facing |
| Step B journal slice | `AssistantTurnJournal` deduplicates normalized canonical item groups; it no longer inspects `rawItem`, and wrapped/direct tool items share one identity |
| Step B stream-finalization slice | Resume replay deduplication and tool-result detection use canonical tool identities while preserving original provider items in conversation history |
| Step B stream-event slice | Run-item tool lifecycle interpretation uses canonical calls/results while journal and recovery hooks retain the original provider items |
| Step B replay slice | Replay detects existing reasoning, tool calls, and tool results through canonical normalization while retaining the original provider history objects |
| Step B tool-ledger slice | `ToolExecutionLedger` derives tool call/result classification, identity, name, arguments, output, reasoning detection, and reconciliation from `run-item-normalizer.ts`; equivalent wrapped, direct-provider, and canonical forms share one identity while stored history remains provider-facing |
| Step B journal-to-ledger slice | Durable journal recovery detects missing reasoning and existing tool results through `run-item-normalizer.ts`; wrapped, direct-provider, and canonical items deduplicate equivalently while reconstructed history preserves original provider items, ordering, and ledger persistence behavior |
| Step B provider-history projection slice | `conversation-turn-items.ts` owns canonical persisted tool call/result/reasoning projection back to provider history; completed-turn replay and interrupted-journal ledger recovery share it, retaining provider-native fields while reconciling aliases, serializing object arguments, and emitting reasoning once |
| Step B history-repair slice | Conversation-history repair normalizes tool calls/results for signatures, pair detection, and repair decisions; equivalent wrapped, direct-provider, and canonical forms repair alike while retained history keeps its original representation |
| Step B conversation-store tool-policy slice | `ConversationStore` normalizes only tool-output retry anchors and mutating-tool rewind previews; wrapped SDK, direct-provider, and canonical items share classification/call ID/name/arguments/output while splice indices and original provider-facing history remain intact |
| Step B conversation-message projection slice | `conversation-message-projection.ts` read-only projects direct or one-level wrapped user, assistant, and system messages for conversation-store turn handling and stream finalization message detection; provider history remains original |
| Step B approval-history projection slice | Shell auto-approval compact context uses `conversation-message-projection.ts`; direct and one-level wrapped user/assistant messages render equivalently while system, tool, and reasoning items remain excluded and history remains original |
| Step B input-surge guard slice | `InputSurgeGuard` derives duplicate tool signatures and call/result pair counts from canonical `ToolCall`/`ToolResult` projections; wrapped SDK, direct-provider, and canonical tool inputs share policy behavior while serialized input bytes and message counts remain original |
| Step B chained-input-filter slice | Chained request delta selection and recognized tool call/result classification use `run-item-normalizer.ts`; direct, one-level wrapped, and canonical tool forms retain original input object identity/order/slicing, while explicit call-ID precedence, generic `*_call` compatibility, and user-message detection remain local policy |
| Step D inert streamed-turn contract + Agents bridge | `contracts/streamed-model-turn.ts` owns a closed text/image, reasoning, function-call/result, and structured tool-result protocol for one turn; `agents-model-bridge.ts` temporarily adapts it to public Agents Model events without routing or provider changes |
| Step D unrouted AI SDK streamed turn | `providers/ai-sdk-streamed-model.ts` translates the closed turn protocol directly to a normalized LanguageModelV3 stream and returns deltas plus one authoritative completion; no production provider is routed through it |
| Step D OpenRouter routing slice | `AiSdkOpenRouterProvider` routes its LanguageModelV3 through `createAiSdkStreamedModel()` and the temporary Agents bridge; its OpenRouter-specific forwarding retains legacy reasoning, provider options, extra request fields, configuration/fetch, stream signal/error, and completion behavior |
| Step D Google routing slice | `AiSdkGoogleProvider` routes its LanguageModelV3 through `createAiSdkStreamedModel()` and the temporary Agents bridge; the shared narrow call-settings wrapper retains Google’s explicit provider-data convention while OpenRouter’s reasoning special case remains local |
| Step D Anthropic routing slice | `AiSdkAnthropicProvider` routes its cache/max-token-wrapped LanguageModelV3 through `createAiSdkStreamedModel()` and the temporary Agents bridge; the shared explicit-provider settings rule preserves Anthropic’s top-level provider data and nested precedence while caching/max-token policy stays local |
| Step D adapter retirement | The unused AI SDK Agents adapter, its characterization test, and direct `@openai/agents-extensions` dependency/lockfile entries are deleted; routed-provider and application-owned boundary tests retain the behavior |
| Step E chaining disposition | Full provider-facing history is authoritative; OpenAI/Codex continuation becomes an opaque provider-private, exact-prefix-anchored checkpoint with candidate → accepted → retired lifecycle and provider-classified replay |
| Step E Stage 0 characterization/instrumentation | Immutable provider-history snapshots, exact prefix-bound checkpoint lifecycle/reset lineage, terminal-commit-only promotion, and optional exact OpenAI/Codex request-projection capture are pinned without changing wire selection or provider behavior |
| Step E Stage 1 OpenAI parity/handoff slice | Immutable snapshots flow through initial and workflow-owned continuation run options to an OpenAI-private exact-prefix compatibility projection; parity observation returns the established global chained-input result and leaves Codex unchanged |
| Step E fresh-session OpenAI provider projection switch | Newly created OpenAI session clients freeze a compatibility mode and select the parity-proven provider projection only for exact-prefix, structural-parity outcomes; legacy, Codex, mismatched, unequal, and failed cases retain the established baseline |
| Step E request/response correlation prerequisite | OpenAI-private HTTP/WebSocket observations pair opaque public-call tokens, exact post-builder request projections, and normalized terminal response IDs without creating candidates; production candidate observation remains blocked by truthful account identity and exact snapshot-prefix binding into the provider token |
| Step C continuation IDs | `continuation-call-id-resolver.ts` uses public interruption IDs plus current-turn completed IDs from the session ledger; it no longer reads `_generatedItems` |
| Step C replay diagnostics | Duplicate-tool replay diagnostics inspect public `history` / `newItems`; `stream-snapshot.ts` no longer reads `_generatedItems` |
| Step C transport recovery | `SessionStreamProcessor` records each public completed tool result in the live ledger before recovery; fresh retry projects that ledger (merging journal data only as an older snapshot), with no RunState recovery read |
| Step C post-execute handoff | Selected root tools can pause after execution through a session-owned registry; the UI settles revisioned entries and resumes the same live stream consumer, with fail-closed abort/reset/disposal |
| Step C denied-read migration | Root shell denied reads pause before the SDK sees a result; typed choices re-execute the held call with call-ID-isolated overrides, while rejection returns the original denial |
| Bug fix | Chained-continuation orphan checks include current-turn call IDs from the session ledger, not only terminal history |
| Bug fix | Denied-read approval never fired for `cd`-prefixed commands (record/lookup key mismatch) |
| Bug fix | Docker host-control denials leaked across sessions (process-global `#deniedCommands`) |

Each landed as a `--no-ff` merge from its own worktree branch; branch history is preserved.

### Current boundary

The post-execute seam is now deliberately limited to tool construction. `ToolDefinition.postExecute`
runs after its original `execute` resolves and before the SDK receives a result. It receives
normalized parameters, the original result, SDK details (including the call ID), and a non-recursive
`executeAgain()` that retains those details. A policy may wait for an external decision; the SDK
then cannot issue request B until it returns exactly one final result.

The session/UI/TurnWorkflow handoff is session-owned: the owned client factory creates a fresh
registry and explicit epoch token, gives its root `AgentClient` a lazy active-live-run capability,
and preserves that closure through agent rebuilds. Selected root definitions opt in at tool
construction; nested tools deliberately do not inherit this capability in this slice. The adapter
settles the displayed revision/entry before re-observing the same LiveRun, without building an SDK
approval decision. Registry snapshots remain selective and revisioned; a later entry produces a
new boundary after the selected one settles. Abort, reset, and disposal fail-close gates and stop
late event projection. Do not substitute a `callModelInputFilter` sentinel.

Root denied-read metadata and one-shot execution overrides now use this seam. The held call
retains its call ID, so no model retry, command matching, or token protocol is needed. Concurrent
identical root commands retain separate metadata and decisions; nested tools remain unchanged.

### Step E chaining disposition — decided

The application’s complete provider-facing history is the authoritative semantic record. Remove the
global `delta | full_history` policy incrementally; it is an application-wide ownership leak, not a
durable conversation model. At the OpenAI/Codex provider boundary, the application supplies an
**immutable full-history snapshot**. A provider compatibility seam may privately project its suffix
and attach an opaque continuation checkpoint. Stage 1 must preserve the exact current projected
wire inputs before changing ownership; do not move in-flight approvals or sessions between the old
and new ownership modes.

A checkpoint is **not** a floating response ID. It binds a response ID and any transport state to:

- provider, account, endpoint, and model identity;
- reset lineage/epoch; and
- the exact transcript-prefix revision and identity it represents.

Its lifecycle is explicit: a response may create a **candidate** checkpoint when observed; it is
**accepted** only when that response’s terminal output is committed to authoritative history; it is
**retired** when reset, identity/prefix mismatch, invalid-continuation rejection, or reconciliation
supersedes it. Checkpoint promotion and terminal-history commit are one logical operation. A stale
completion, including one arriving after reset, cannot promote a candidate.

Full replay is a provider-classified recovery path, not a generic retry. It is permitted only after
an explicit pre-generation invalid-continuation rejection or reliable provider reconciliation. It is
not permitted after an ambiguous timeout or disconnect, where the provider may have generated a
response; retain the candidate and surface/recover through the provider’s ambiguity policy instead.

OpenAI migrates first: it is lower risk than Codex, but the completed trace does **not** prove that
chaining is a pure optimization, so do not claim that. Codex begins with full replay unsupported
until tests prove semantic sufficiency: `store = false`, server chaining, and WebSocket transport
state are load-bearing. This is deliberately a compatibility seam, not a new shared continuation
framework.

**Evidence map / current owners.** `SessionInputPlanner` currently selects `delta` versus
`full_history`; `ProviderContinuity` owns the mutable previous-response state; `TurnWorkflow`
passes `previousResponseId`; `AgentRunOrchestrator` passes it to the SDK and applies
`chained-input-filter`; and `SessionStreamProcessor.finalize` currently updates continuity beside
terminal history handling. Existing evidence is concentrated in the input-planner and
`provider-continuity` tests, `turn-workflow.call-ids.test.ts`, `agent-run-orchestrator` /
`chained-input-filter` tests, `session-stream-processor.test.ts` (including stale finalization),
and session lifecycle/reset plus recovery-executor/continuation-recovery tests. Stage 0 extends
these seams rather than inventing parallel ownership.

**Stage 0 observation boundary.** Candidate creation is deliberately an inert, opt-in
instrumentation hook in Stage 0: production does not call `observeCandidate`, because no existing
owner can truthfully supply both provider/account/endpoint/model identity and the exact request
prefix binding at response observation. `SessionStreamProcessor` characterizes the terminal
commit/promotion side only. Stage 1 must connect response-observed to terminal commit at the
provider-private seam after it can provide that exact binding; Stage 0 does not migrate production
checkpoint ownership or alter continuation/retry policy.

### A4 tool-ownership lifecycle

`createOwnedSessionClientFactory()` creates one fresh `ToolOwnershipRegistry` per session handle
and gives that exact instance to the root `AgentClient`. The handle exposes it to
`createConversationRuntime()`, which passes it to `ApprovalFlowCoordinator`; `AgentClient` passes
the same instance through its `SubagentBridge`, `SubagentManager`, subagent runtime, execution
runner, and nested runner. Thus a nested call can be claimed and later resolved by the approval
flow without a process-global registry. Caller-owned client seams explicitly receive a registry.
On reset, `ConversationService` disposes the old handle and creates a new one, so its registry is
not reused; disposal clears the registry along with the old session epoch.

The same handle now owns `SessionAccessState`. Root `read_file`, root `shell`, approval
classification/result building/batch handling, and `ApprovalFlowCoordinator` receive the exact
capability through the composition path; they do not resolve a current session or a fallback
store. Reset/import clear its transient read folders, Docker one-shot/session grants, and
indirect-Docker denials; disposal does the same. Docker project grants remain settings-backed.

**A4 compatibility decision:** the old command-keyed denied-read protocol remains only as
`NestedToolCompatibilityState`, created explicitly for a nested-tool runtime (or injected by a
test). It owns its denied-read/override, read-access, and Docker compatibility stores; root
tools do not import or select those stores. It is intentionally not a `SessionAccessState`, does
not carry the root post-execute capability, and cannot inherit held root calls or their
call-ID-isolated overrides. The remaining module-level store exports are test reset seams only.

Test fixtures now explicitly create fresh registries, sharing one only when a fixture exercises
the parent/nested ownership relationship. This keeps test identity/lifecycle aligned with the
production session contract.

### Validation at post-execute seam

- Step B's focused normalizer, turn-item compatibility, turn accumulator, stream, replay,
  state projector, tool-ledger, and chained-filter set passes: 6 files / 108 tests.
- `source/lib/sdk-approval-resume.test.ts` passes its real-Runner approval-resume and
  denied-read model-retry regressions. The latter observes call A at execute, then a distinct
  call B at `needsApproval`, where B interrupts before execute.
- The post-execute seam has focused unit coverage for rejection and non-recursive reexecution,
  plus a real streaming SDK `Runner` regression through `buildAgentTools`. It proves the original
  execution completes, the policy holds request B pending, approval re-executes with the same call
  ID, and exactly one final result reaches request B. Ordinary factory-built tools remain without
  a policy and retain their existing behavior.
- Post-execute session handoff focused set passes: registry, policy (including missing SDK call
  ID), LiveRun, TurnWorkflow repeated-boundary, root tool factory, adapter, session-client
  factory, turn coordinator, conversation service, and session composition tests: 10 files / 128
  tests. `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Root denied-read migration focused sets pass: shell, post-execute policy/registry, TurnWorkflow,
  adapter, and agent factory (6 files / 99 tests), plus approval flow and session composition,
  client factory, conversation service, and turn coordinator (5 files / 106 tests). The migration
  covers same-call re-execution, typed denied-read choices, concurrent identical-call isolation,
  missing-call-ID failure, and compatibility behavior outside the root capability.
- Worktree-local `pnpm` validation runs with the existing `node_modules` symlink; no dependency
  installation was performed. Root-level `pnpm lint` is not a meaningful baseline with sibling
  worktrees present: ESLint traverses them and reports their files as outside the root TypeScript
  project.
- Full `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Continuation-call-id resolver slice: resolver, ledger, tracker, TurnWorkflow parity, and
  approval-batch tests pass (5 files / 50 tests). `tsc --noEmit` again reaches only the known
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Chained orphan-guard regression: TurnWorkflow now proves a continuation receives both committed
  history call IDs and uncommitted current-turn call IDs from `SessionToolTracker`.
- Replay-diagnostics slice: conversation stream and stream-processor tests pass (2 files / 27
  tests); diagnostics retain public history/new-item duplicate detection and drop private-state
  metadata.
- Transport-recovery slice: a real streaming SDK `Runner` executes two tool cycles and rejects
  the following model request; public stream events plus `history`, `newItems`, and `output`
  retain both completed outputs. The regression separately awaits the iterator and `completed`
  rejections. Session stream processing and recovery-executor regressions prove completed outputs
  enter the live ledger before fresh recovery projects them, with the journal only an older
  snapshot. Focused set: 4 files / 35 tests.
- Focused tool-ownership clusters pass: 23 files / 364 tests, plus the 4-test conversation
  integration fixture. Formatting and lint pass except the pre-existing `prefer-const` warning
  in `services/subagents/runtime.ts`.
- After building `dist/`, full Vitest reaches 4,615 passing / 1 skipped / 1 failing. The sole
  failure is the pre-existing sandbox terminal E2E failure in `source/cli.e2e.test.ts` (the child
  terminal exits before rendering `Lite`); it reproduces on the baseline checkout.
- No dependency installation was run; this worktree uses its existing `node_modules` symlink.
- A4 lifecycle follow-up focused set passes: session access/handle, execution runner,
  root read/shell, and approval flow (6 files / 103 tests). Typecheck reaches only the
  known `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline.
- Provider-history projection slice: turn-item synthesis and conversation replay focused tests
  pass (2 files / 53 tests). They cover native field retention, `call_id` / `tool_call_id`,
  `args` / `result`, object argument serialization, reasoning de-duplication, completed replay,
  interrupted journal recovery, and ledger history ordering.
- Chained-input tool projection slice: chained filtering and run-item normalization focused tests
  pass (2 files / 65 tests), plus all 49 Codex response-model regressions. They cover direct,
  one-level wrapped, and canonical forms; supported call/result spellings; wrapper-first call-ID
  precedence; provider item IDs kept distinct from tool-call correlation; original result identity;
  and unchanged missing/orphan validation.
- Full Vitest after the chained-input slice reaches 4,723 passing / 1 skipped / 1 failing. The sole
  failure remains the pre-existing sandbox terminal E2E failure in `source/cli.e2e.test.ts`.
- Step D adapter characterization: `ai-sdk-agents-adapter.test.ts` now pins public `Model`
  behavior with fake LanguageModelV3 implementations: request translation (instructions,
  messages, tools, named tool choice), assistant-message merging, exact streamed string tool
  arguments, raw/derived event ordering, authoritative `response_done`, missing/zero/cached
  usage semantics, AbortSignal forwarding/cancellation, provider-error propagation, and the
  existing reasoning/provider-option forwarding. Focused adapter and message-normalizer tests:
  2 files / 25 tests pass.
- Step D inert contract + bridge: focused contract/bridge, adapter/message-normalizer, and real
  Runner approval-resume tests pass (5 files / 37 tests). A real streaming Runner also consumes the
  temporary bridge through terminal output. The set covers live delta delivery before completion,
  image input, structured text/image/file tool results, exact tool arguments, explicit model
  settings/provider options, reasoning and tool-call model events, authoritative completion,
  required response IDs/provider metadata, signal identity, errors, missing-versus-zero usage, and
  terminal-event enforcement. No provider routing, registry, Codex, chaining, or AI SDK
  implementation changed.
- Step D unrouted AI SDK streamed turn: focused implementation, contract/bridge, and adapter
  characterization tests pass (5 files / 39 tests). The implementation preserves system text-only
  validation while converting user/assistant media, structured text/image/file results, assistant
  normalization, exact tool-call arguments, live text/reasoning/tool events (including
  reasoning-end metadata), completion metadata/usage with missing-versus-zero totals, abort-signal
  identity, provider-error propagation, response-ID/finish enforcement, and terminal completion.
  Full `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Step D OpenRouter routing slice: focused OpenRouter provider, direct implementation, temporary
  bridge, and legacy adapter-characterization tests pass (4 files / 31 tests). A fake
  LanguageModelV3 proves configuration/custom fetch preservation; public Agents stream request
  settings, OpenRouter reasoning/provider options and extra request fields; live reasoning/text/tool
  events; completion metadata/usage; signal identity; and provider-error propagation through the
  routed direct turn and bridge. Formatting/lint pass for the changed files. Full `tsc --noEmit`
  reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Step D Google routing slice: focused Google/OpenRouter providers, direct implementation,
  temporary bridge, legacy adapter characterization, and custom-provider adapter tests pass
  (6 files / 40 tests).
  A fake Google LanguageModelV3 proves configuration/custom fetch and selected/default model
  preservation; public Agents stream request/tool settings; explicit `google` provider options
  with nested-option precedence, top-level extra fields, and the legacy fallback response ID;
  direct reasoning without OpenRouter nesting;
  live reasoning/text/tool events; authoritative completion metadata/usage; signal identity; and
  provider-error propagation. The only shared extraction is the cohesive doStream call-settings
  wrapper; OpenRouter’s extra top-level forwarding and reasoning handling remain explicit. Full
  `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Step D Anthropic routing slice: characterization covers selected/default model and configuration,
  forced per-model output limits, injected cache markers, explicit `anthropic` provider-data
  forwarding, reasoning signature/end ordering, streamed text/tool calls, authoritative response
  metadata/usage, signal identity, and provider errors. Focused Anthropic/Google/OpenRouter,
  direct-turn, bridge, legacy-characterization, and custom-provider coverage passes: 7 files / 50
  tests. Full `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Step D adapter retirement: deleted the now-unreferenced `ai-sdk-agents-adapter.ts` and its
  characterization test, removed the direct `@openai/agents-extensions` manifest and lockfile
  entries without installing dependencies, and retained the routed OpenRouter/Google/Anthropic,
  direct-turn, bridge, custom-provider, and shared message-normalizer coverage. Focused retained
  tests pass; source/dependency scans find no remaining adapter or extensions import/reference.
  Formatting of retained changed files passes; this deletion-only source change leaves no retained
  lintable source file. Full `tsc --noEmit` reaches only the known
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532` baseline failure.
- Step E Stage 0 characterization/instrumentation: focused store, continuity, input-planner,
  stream-processor/reset/composition, chained-wire, OpenAI, and Codex coverage passes (9 files /
  186 tests). It pins immutable snapshot identity, exact checkpoint binding and lifecycle, reset
  retirement/stale non-promotion, terminal-commit-only promotion, and structured exact request
  capture after OpenAI builder/prompt-cache forwarding and Codex normalization/private-fetch seam.
  Formatting passes. Full `tsc --noEmit` reaches only the known pre-existing
  `source/services/conversation/conversation-orchestrator.test.ts:458 TS2532`; the attempted full
   Vitest run was sandbox-blocked on Docker host control before tests began.
- Step E request/response correlation prerequisite: OpenAI-private HTTP/WebSocket public-call
  observations pair opaque attempt tokens with the exact post-builder request projection and the
  normalized unary `responseId` or streamed `response_done.response.id`; concurrent request
  objects remain isolated, terminal/failure/consumer-abandon paths clean state, and observer
  failures are swallowed. This remains instrumentation only: it does not call `observeCandidate`,
  attach snapshot metadata to wire settings, classify replay, or bind live checkpoints. Truthful
  account identity and snapshot-prefix handoff into the provider token remain blockers for production
  candidate observation.
- Step E bounded fresh-session OpenAI projection ownership switch: newly created OpenAI handles
  freeze and pass an explicit compatibility mode into their client/orchestrator, selecting the
  parity-proven provider projection only for exact prefix and structural-parity outcomes. Legacy,
  Codex, mismatched, unequal, and failed compatibility cases retain the established baseline;
  checkpoint candidates, approvals, replay, and private reach-ins are unchanged.

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

1. **DONE — Stage 0 characterization/instrumentation; no wire change.** Immutable snapshot identity
   and exact prefix anchoring, candidate → accepted → retired lifecycle behavior, stale completion
   after reset, and terminal-history-commit/checkpoint-promotion ordering are pinned at the current
   owners. Candidate creation remains an inert opt-in hook until production observation can supply
   truthful account identity and exact snapshot-prefix binding into the provider token; checkpoint
   ownership has not migrated. Optional
   structured capture records exact existing OpenAI/Codex request projections for later parity
   comparison. This neither changes request payloads, continuation ownership, approval/session
   migration, nor fallback behavior, and retires no reach-in.
2. **DONE — Stage 1 OpenAI parity/handoff and bounded fresh-session ownership switch.** Full-history snapshots now reach the
   OpenAI boundary and an OpenAI-private compatibility projection records exact prefix evidence and
   parity against the established global chained-input filter. New OpenAI session handles use that
   projection only when its exact-prefix result remains structurally identical to the baseline;
   legacy and Codex paths remain baseline. Checkpoint ownership has not migrated, no reach-in is
   retired, and in-flight sessions/approvals are unchanged.
3. **DONE — request/response correlation prerequisite; observation only.** OpenAI-private
   HTTP/WebSocket public-call observations pair opaque attempt tokens, exact post-builder request
   projections, and normalized terminal response IDs. Terminal observations without a response ID
   remain terminal-but-not-candidate evidence; no ID is fabricated. This does not call
   `observeCandidate`, attach snapshot metadata to wire settings, classify replay, bind live
   checkpoints, or retire a reach-in.
4. **Next — production candidate checkpoint observation at the provider response seam only after
   truthful provider/account/endpoint/model and request-prefix binding can be supplied.** Do not
   broaden this to Codex, change replay classification, or claim checkpoint ownership migration
   without the live evidence.

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
4. **DONE:** root denied-read metadata and execution overrides use the landed
   post-execute seam. The held live call has stable identity; reject command-key fallback and a
   temporary token protocol. Keep nested compatibility behavior outside this root capability.
5. **DONE.** Move root session read access and transient Docker state into the handle,
   keeping project grants persistent; bind transient execution clients to disposal.
6. Delete singleton fallbacks and compatibility wiring after all production roots inject the
   session-owned capabilities.

### Deliberately left open

Concurrent identical root `shell` calls are now covered by a call-isolation regression. The
post-execute seam holds and re-executes each live call by its own call ID. The old command-keyed
stores remain only on the nested compatibility path; do not extend that fallback back to roots.

### Resumed `RunState` replays generated items — contained, not fixed (2026-07-28)

**Whoever owns the Step C run loop should fix this properly; do not re-diagnose it from scratch.**

A resumed run re-offers the tool call/result pairs from every earlier segment. Across successive
`continueRunStream` finalizations the same pairs arrive again and again, so appending them
unfiltered grew provider history quadratically until the input surge guard blocked the turn.
Observed in session `136e6e11` on 2026-07-28: duplicate copies per pair went 4 → 4 → 11 → 13 over
about three minutes, ending at 73 items / 108 KB and a hard `input_surge_guard` block mid-turn.
It surfaced through the background subagent notification path, so an orchestrator run can die on a
leak the user did not cause.

Confirmed from `conversation.stream_history.replayed_tools` warnings in the app log:

- Every occurrence had `source: continueRunStream`. Never `startStream`. This is the resume path.
- `history`, `newItems`, and (in the then-current build) `state.generatedItems` all showed the
  *same* duplicate counts, so the accumulation is in the run state carried across resumes —
  `continuation-state.ts` reuses `pendingApprovalContext.state` — not in our store logic.
- The provider never saw the duplicates. All 59 provider-traffic files that day had max repetition
  2 per `call_id` (the normal call + output), because `#filterAndGuardChainedModelInput` strips
  them while chaining is active. The damage only became visible when a turn fell back to
  `full_history`, which is the request that got blocked.

**What is already done (`76ea0e0f`).** `SessionStreamProcessor.finalize` filters tool call/result
items already present in the store before appending, keyed on `type:callId`. That is a containment
at the commit seam, chosen because it is decouple-neutral: it touches no SDK type and survives
whatever replaces `RunState`. Non-tool items are never filtered and `replaceHistory` stays
authoritative. Regression: *"does not re-append tool call/result pairs already in history across
resumes"* in `session-stream-processor.test.ts`.

**What remains for the run-loop owner.** The resumed state still accumulates. When the run loop
stops carrying accumulated generated items across resume segments, this stops at the source and the
`finalize` filter becomes belt-and-braces — keep the regression test either way, since it pins a
property (no duplicate pairs in committed history) that should hold under any run loop.

**How to tell it is still happening.** `finalize` logs
`conversation.stream_history.replay_dropped` with the dropped `type:callId` signatures whenever it
filters something. That warning going quiet is the signal the underlying duplication is gone.

**One unverified assumption in the containment.** It dedupes on `type:callId` without comparing
content, so if a resumed call ever produced a *different* output under the same call ID, the newer
one is dropped. Nothing in the traffic logs suggests this happens and the accumulated items are
item-identical, but it was not proven. The `replay_dropped` signatures are the trail if it ever
does.

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
| ~~`_generatedItems`~~ | ~~`services/stream-snapshot.ts`~~, ~~`services/session/session-tool-tracker.ts`~~, ~~`services/session/continuation-call-id-resolver.ts`~~ | run loop | **DONE** (Step C public stream/ledger recovery) |
| `_buildResponsesCreateRequest` | `providers/codex-responses-model.ts`, `providers/openai.provider.ts` | provider | Step D/E |
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

Asymmetry: OpenAI is lower risk, but the completed trace does not prove chaining is a pure
optimization there. Codex chaining is load-bearing — `agent-factory.ts:254-256` sets
`store = false`, while `codex-responses-model.ts` threads `previousResponseId` through its
remembered-response-id cache and consumed-tool-result tracking. The WS transport holds server
state outside the normal `store` flag. Therefore the application must retain full provider-facing
history as its semantic record and treat both providers’ continuation details as private,
prefix-anchored compatibility state; Codex cannot claim full-replay support until tests prove it.

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
| Approval type scope | Step B defines the types. Step C's landed post-execute seam now owns the root denied-read migration: carry metadata and selected one-shot overrides by the held live call ID; reject command fallback and token protocols. Nested tools retain compatibility behavior until explicitly migrated. |
| Chaining semantic record | **Full provider-facing history is authoritative.** Remove the global `delta | full_history` policy incrementally; provider suffixing is a private compatibility projection. |
| Continuation checkpoint | **Opaque, identity- and prefix-anchored state, not a floating response ID.** It binds response/transport state to provider, account, endpoint, model, reset lineage/epoch, and exact transcript-prefix revision/identity. Candidate → accepted promotion is atomic with terminal history commit; reset/stale completion cannot promote. |
| Continuation recovery | **Provider-classified.** Full replay is allowed only after explicit pre-generation invalid-continuation rejection or reliable reconciliation, never after ambiguous timeout/disconnect. |
| Migration order | **OpenAI first; Codex later.** OpenAI is lower risk but not proven “pure optimization.” Codex full replay is unsupported until tests prove it despite `store = false`, chaining, and WS state. |
| Endpoint | Zero SDK imports, **codex included**. |

### Resolved interlock — Step E implementation gate

The disposition removes the contradiction without pretending Codex can replay today: application
history remains complete, and provider continuation becomes a compatibility projection anchored to
that history. Stage 0 must first characterize snapshot identity, exact prefix anchoring, and
candidate/accepted/retired transitions with no wire change. Stage 1 moves existing suffix
projection behind the provider seam and compares exact projected inputs. Only then may OpenAI
change ownership. Codex remains in its current compatible chaining mode until its server-state,
`store = false`, and WebSocket assumptions have direct proof. Never migrate an in-flight approval
or session across modes; rollback retains the established mode and its checkpoint until a fresh
session/reset boundary.

---

## Sequencing (fragility-first)

Re-ordered from the original types-first plan. Each step retires named reach-ins.

### Execution model — sequential seams, parallel implementations

Use a hybrid execution strategy. Shared contracts and architectural seams proceed sequentially;
independent provider implementations may proceed in parallel only after those seams are stable.

1. **Sequential — establish the application-owned provider contract for Step D.** Settle request,
   streamed-event, tool-call/result, usage/completion, and provider-native continuation boundaries
   before assigning provider migrations. One owner integrates this contract.
2. **Parallel — migrate independent AI SDK providers.** Once the contract is stable, Google,
   Anthropic, and OpenRouter may move in separate worktrees. Integrate sequentially, then retire
   the legacy adapter and run the cross-provider suite.
3. **Sequential — Stage 0 characterization/instrumentation.** Pin immutable snapshot identity,
   prefix anchoring, and candidate → accepted → retired lifecycle at the existing session seams,
   with no wire change. Gate on exact current suffix-projection captures and stale-after-reset
   coverage; rollback is deletion of instrumentation/characterization only.
4. **Sequential — Stage 1 compatibility seam.** Supply full-history snapshots at the provider
   boundary, move the current suffix projection behind OpenAI/Codex-private seams, and compare
   exact projected inputs. Do not migrate in-flight approvals/sessions. Gate on parity; rollback
   keeps the old global path for newly started sessions.
5. **OpenAI first — narrow ownership migration.** Promote only accepted terminal checkpoints with
   the history commit; classify invalid-continuation recovery. Gate on no payload regression and
   explicit/reconciled-only replay; rollback disables the OpenAI seam for new sessions.
6. **Codex last — validate before enabling replay.** Keep chaining, `store = false`, and WS state
   compatible while retiring reach-ins. Full replay remains unsupported until provider tests prove
   semantic sufficiency; ambiguous timeout/disconnect never triggers replay. Roll back to the
   compatible checkpoint path at a fresh session/reset boundary.

Read-only audits, test-gap analysis, and review may run in parallel at any stage. Changes that share
contracts, schemas, state flow, or transport semantics remain sequential.

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
- **A4 — PARTIAL; Step C migration landed.** Session-owned tool ownership is landed. R1 remains
  valid only for a same-call approval resume; the model-retry regression still proves that a
  completed denial would get a new ID. The landed Step C seam instead holds the completed root
  call before the SDK sees it, so denied-read metadata and one-shot overrides can now migrate by
  that stable live call ID. Reject command fallback and temporary token protocols.

**Live bugs found during this work** (the root command-keyed issue is now being replaced through
the Step C seam; compatibility paths remain explicit):

- **FIXED** — denied-read approval never fired for `cd`-prefixed commands. `shell.ts` recorded
  under `optimizedCommand` (post-`stripRedundantCd`) while both lookups used the raw
  model-emitted command. Six of seven store call sites already used raw; `record` was the sole
  outlier. The Docker branch ten lines above already had the correct reasoning in a comment.
- **FIXED for roots in Step C** — concurrent identical commands previously cross-contaminated grants.
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
`rawItem` remains in downstream consumers while the application is still on the SDK, but
`source/contracts/` itself no longer imports `@openai/agents*`; `ReasoningEffortSetting` is an
application-owned string union. Continue moving interpretation behind the canonical boundary
without discarding provider-native items needed for replay or formatting.
**Retires 0 reach-ins directly; contains them and collapses blast radius.**

**Landed follow-up.** Root denied-read recovery uses the Step C post-execute seam without command
matching or a temporary token protocol. Nested tools retain the compatibility path.

**Landed representation slice.** `source/contracts/conversation-items.ts` now owns the canonical
serializable item and turn shapes; compatibility aliases in `conversation-persistence-types.ts`
preserve existing persisted imports. `Approval` reuses `ApprovalDescriptor`, and
`ReasoningEffortSetting` is the app-supported string union instead of an SDK import.
`run-item-normalizer.ts` owns the raw-item-to-`Item[]` adapter, while
`conversation-turn-items.ts` delegates its legacy builders and retains provider-facing replay.
This contains normalization only: it does not remove SDK reach-ins, migrate all raw items, or
alter requests, RunState, chaining, approval/resume, denied-read, execution overrides, or run-loop behavior.

**Step B command-message slice.** Command-message streaming and extraction now normalize direct
or wrapped provider inputs once into canonical tool calls/results before caching arguments and
formatting. Cached arguments live on an enriched local result rather than mutating canonical
items; `providerItem` remains available for provider-specific formatting (including native
`apply_patch` details). Call-ID fallbacks, stable command-message IDs, annotations, output
coercion, and existing formatting behavior remain intact.

**Step B assistant-journal slice.** `AssistantTurnJournal` now normalizes before deduplication and
derives identity only from canonical tool call/result IDs or provider item IDs. It no longer
inspects `rawItem`. Provider wrappers and equivalent direct canonical tool items deduplicate as
one item group, and multi-item normalizations remain all-or-nothing on replay.

**Step B stream-finalization slice.** Resume replay deduplication and full-history tool-result
detection in `SessionStreamProcessor` now normalize through the canonical item boundary instead of
inspecting `rawItem`, provider result type spellings, or call-ID field variants. Equivalent wrapped,
direct-provider, and canonical tool representations share one identity. Items that survive the
filter retain their original provider representation in conversation history.

**Step B stream-event slice.** `run_item_stream_event` tool lifecycle interpretation now uses
canonical tool calls and results for `tool_started`, argument diagnostics, and recovery-hook
dispatch. Wrapped SDK items, direct provider items, and canonical items behave identically, while
generic journal and function call/result hooks continue receiving the original item object for
provider-facing persistence and replay.

**Step B replay slice.** Replay ledger merging now normalizes existing history through the canonical
run-item boundary before detecting reasoning, tool calls, or tool results. Wrapped provider,
direct-provider, and canonical representations are equivalent for deduplication, but the original
history objects remain in the ledger and provider replay history.

**Step B tool-ledger slice.** `ToolExecutionLedger` now obtains tool call/result classification,
call identity, tool name, arguments, output, reasoning detection, and reconciliation matching from
the application-owned run-item normalizer. Wrapped SDK, direct-provider, and canonical `ToolCall` /
`ToolResult` inputs therefore have one ledger identity, including the established `callId`,
`call_id`, `tool_call_id`, `toolCallId`, and `id` fallback compatibility. Ledger recovery continues
to store and reconstruct the original provider-facing item rather than a canonical replacement;
ordering and reasoning-prefix insertion remain unchanged. Unknown items remain untouched.

**Step B journal-to-ledger slice.** Durable assistant-turn and journal-event recovery now uses
`run-item-normalizer.ts` to detect an existing reasoning item and a completed tool result for a
call. Wrapped SDK, direct-provider, and canonical reasoning/tool-call/tool-result history forms
therefore make the same prefixing and deduplication decisions. Reconstruction still preserves the
original provider-facing history object, ordering, and persisted ledger output.

**Step B history-repair slice.** `conversation-history-repair.ts` now obtains tool call/result
signatures, duplicate-pair counts, and duplicate-removal decisions from `run-item-normalizer.ts`.
Wrapped SDK, direct-provider, and canonical tool histories therefore repair equivalently; retained
entries remain the original provider-facing objects. Message/user and provider-ID signatures remain
local because canonical `Item` does not model those history shapes.

**Step B conversation-store tool-policy slice.** `ConversationStore` now obtains only its
last-tool-output retry anchor and mutating-file rewind preview fields from `run-item-normalizer.ts`.
Wrapped SDK, direct-provider, and canonical tool calls/results therefore make equivalent anchor,
truncation, call-ID/name/output, and malformed-argument decisions; `removeAfterLastToolOutput()`
keeps its original anchor index/splice behavior and history retains its original provider-facing
objects. The normalizer now explicitly covers every legacy result spelling the store supported.
User/assistant message unwrapping, synthetic-message handling, turn counting/removal, and
message text/image extraction intentionally remain local for a later slice.

**Step B conversation-message projection slice.** `conversation-message-projection.ts` now owns
a read-only projection of direct provider messages and one-level SDK `{ rawItem }` wrappers. It
recognizes current user, assistant, and system message roles; string and input/output-text array
content; input images; empty/malformed content; and shell-context/legacy-mode synthetic user
notices, while returning null for tool and reasoning items. `ConversationStore` uses it for user
turn anchoring/removal, text/image return values, synthetic filtering, and assistant rewind reply
counts; `SessionStreamProcessor` uses it only for full-history message presence selection. Both
retain original provider objects and existing clone/index/splice behavior. Canonical `Item` and
`run-item-normalizer.ts` remain assistant-run/tool-only; no generic/user message variants were
added there.

**Step B approval-history projection slice.** Shell auto-approval compact history now uses that
read-only message projection instead of separately unwrapping `rawItem` and parsing message
content. Direct provider messages and one-level SDK wrappers render the same user/assistant
context; existing whitespace normalization, per-message/context truncation, eight-item source
limit, empty-message `(message)` fallback, and no-context fallback remain unchanged. System,
tool, reasoning, and malformed non-message items remain excluded, while the evaluator retains the
original history objects and does not change approval decisions or prompt semantics beyond
representation equivalence.

**Step B input-surge guard slice.** `InputSurgeGuard` now uses `run-item-normalizer.ts` to inspect
duplicate tool signatures and duplicated call/result pairs. Wrapped SDK, direct-provider, and
canonical `ToolCall` / `ToolResult` inputs share the same call/result classification and supported
call-ID/result-spelling compatibility; signatures retain the canonical call-versus-result distinction.
Unknown and non-tool items remain ignored. The guard still serializes the original input for byte
counts and uses the original input array for message counts, so thresholds and reason strings are
unchanged.

**Step B chained-input-filter slice.** `chained-input-filter.ts` now derives recognized tool
call/result classification through `run-item-normalizer.ts`, including direct and one-level wrapped
provider items, canonical `ToolCall` / `ToolResult`, and result spellings. Explicit call-ID precedence
and the prior generic `_call` extension compatibility remain narrow filter policy: provider item IDs
are not treated as tool-call correlation, and hosted calls do not leak into ledger classification.
User-message detection remains local. The filter continues to return the original input objects in
their original order, selecting or slicing only the input array; missing/orphan validation and
known-call behavior are unchanged.

**Step B bounded representation migration complete.** The remaining representation-only consumers
have been audited and now normalize through the canonical boundary where they need assistant-run or
tool identity. Provider history/replay projection, logging, RunState, orchestration, request
construction, and transports deliberately retain their own boundaries. Proceed with Step D
provider-contract design rather than broadening Step B.

### Step C — Own the run loop
Contained, because downstream already speaks our language.
**Resolver + replay-diagnostics + transport-recovery slices DONE:**
`continuation-call-id-resolver.ts` uses public interruption IDs and current-turn completed IDs
from the session ledger; `stream-snapshot.ts` uses only public stream history/new items for
duplicate-tool diagnostics; and public completed tool results are recorded in the live ledger
before recovery projects them. No production `_generatedItems` read remains.

**Post-execute pause seam — LANDED:** the session/turn channel holds the live stream and resumes
the same consumer with fail-closed lifecycle gates. Root denied-read metadata and per-call
overrides now pass through it; do not grant this root capability to nested tools.

### Step D — Non-codex providers off the SDK
**DONE:** AI SDK providers implement our interface directly; the 112-line legacy
`ai-sdk-agents-adapter.ts`, its characterization test, and direct
`@openai/agents-extensions` dependency/lockfile entries are retired. `ai` and `@ai-sdk/*` remain
dependencies. This does not retire the remaining `_buildResponsesCreateRequest` reach-ins in
`openai.provider.ts` and `codex-responses-model.ts`.

**Characterization decision — LANDED before contract work:** own one streamed model turn first.
The removed adapter characterization informed the application-owned contract; its preserved
behavior is now pinned by the routed OpenRouter/Google/Anthropic, direct-turn, bridge,
custom-provider, and shared message-normalizer tests. That coverage retains request translation,
assistant-message normalization, stream event ordering/final output, usage, cancellation, errors,
and reasoning/provider-option forwarding without retaining the adapter. It intentionally does not
broaden into Codex, chaining, Runner orchestration, speculative non-stream generation,
continuation, a raw event/history bag, a broad error taxonomy, or registry migration. A narrow
shared AI SDK call-settings wrapper captures only common doStream forwarding and
explicit-provider-data semantics; Anthropic retains cache/max-token policy and OpenRouter retains
its local extra-field/reasoning policy rather than adding either to generic turn orchestration.

### Step E — Chaining disposition, then the Codex WS transport
The irreducible risk. **Disposition decided; begin only with bounded Stage 0.** Driven by the
existing `codex-responses-model.test.ts` and `openai.provider.test.ts` — that is hard-won
production knowledge and effectively the spec. Preserve and extend those assertions; do not
discard them. Stage 0 characterizes immutable full-history snapshot identity, exact prefix
anchoring, and candidate → accepted lifecycle without changing wire behavior. Stage 1 places the
current suffix projection behind provider compatibility seams and compares exact projected inputs.
OpenAI migrates first; Codex full replay is unsupported until its tests prove semantic sufficiency.
Related groundwork: `luna-responses-lite-wire-protocol.ts` (112),
`websocket-receive-watchdog.ts` (95).
**Retires the remaining reach-ins.**

---

## Scale of coupling (refreshed 2026-07-29)

- **53 non-test source files** import `@openai/agents*`; 87 including tests.
- A current line-based scan finds **124 non-test `rawItem` lines**.
- A current line-based scan finds **101 non-test `previousResponseId` lines**.
- Out of **814 TS/TSX files under `source/`** (440 non-test). Installed: `@openai/agents-core` **0.11.4**.

These are navigation metrics, not progress measures. Record the counting method when refreshing
them; the risk register remains authoritative. The 2026-07-29 scan uses `fd` for TS/TSX files under
`source/`, then `rg` for line/import counts; every non-test count excludes paths matching
`*.test.*` and `*.e2e.test.*`.

Three clusters: `source/providers/` (~7k LOC incl. tests); the run + approval loop
(`lib/agent-*`, `services/session/`, `services/approval/`, `services/retry/`); and type-only
`AgentInputItem` usage (19 files) across conversation/persistence/logging.

**Not used at all:** handoffs (the `handoff` hits in `source/hooks/` are our own unrelated UI
feature), guardrails, MCP, sessions/memory, voice, realtime.

**Minor dependencies:** `applyDiff` / `applyPatchTool` (native patch for gpt-5.1), the
`tool()` factory, `ModelBehaviorError`, tracing (`withTrace` — mostly we *disable* it),
`ModelSettingsReasoningEffort` (a string union).

## Open questions

- Nested denied-read disposition — retain its compatibility path until an explicit ownership
  model exists; do not implicitly extend the root post-execute capability.
- Whether to keep a `Model`-shaped interface at all, or expose something closer to what `ai`
  already gives us (Step D).
- Codex full-replay semantic sufficiency — explicitly unsupported until its provider/transport
  tests prove it; this no longer blocks bounded Stage 0 characterization.
- Audit the remaining 11 mediation-tax rows — only if LOC becomes decision-relevant again.

## Key file references

- `source/lib/agent-run-orchestrator.ts` (336) — run/stream lifecycle
- `source/lib/agent-factory.ts` (382) — agent + tool construction
- `source/lib/agent-client.ts` (357)
- `source/lib/tool-invoke.ts` (502)
- `source/lib/chained-input-filter.ts` (208)
- `source/services/approval/approval-state.ts` (88) — `RunState` held in memory
- `source/services/approval/approval-flow-coordinator.ts` — approve/reject
- `source/services/approval/tool-owner.ts` (14) — application-owned owner types remain after A2
- `source/services/provider-continuity.ts` (36) — chaining state
- `source/services/session/session-input-planner.ts` (273) — chaining decision point
- `source/services/session/session-stream-processor.ts` (350)
- `source/services/session/turn-workflow.ts` — passes `previousResponseId` into run options
- `source/services/stream-event-processor.ts` (490)
- `source/services/subagents/nested-runner.ts` (445)
- `source/providers/codex-responses-model.ts` (1210) — SDK subclassing
- `source/providers/openai.provider.ts` — remaining OpenAI request-construction reach-in
- `source/services/conversation/conversation-replay.ts` (1149)
