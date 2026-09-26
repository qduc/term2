# Runtime capability seams

Status: **design only; no implementation is authorized by this plan.**

## Resume here

The goal is not to replace `ApplicationRunLoop` with a plugin host. The loop already delegates meaningful policy to collaborators: `RunBudget`, `GenerationGuard`, the retry classifier, request preparation, local boundary compaction, approval services, provider continuity, and tool definitions. Start from those seams; do not extract their policy a second time.

The strongest remaining coupling is turn/segment lifecycle state and the per-response tool plan, both embedded in `ApplicationRunLoop`. Preserve their semantics before considering any split: approval continuation retains the same plan and ledger; cancellation aborts in-flight provider/tool work and settles through existing effect-ledger rules; steers live across segment pauses and are admitted only at request boundaries; tool call/result history remains ordered and paired; provider response IDs remain provider-scoped.

## Goal and measured gap

`ApplicationRunLoop` is not simply an unstructured 2.4k-line loop. Its class owns the model-request lifecycle, mutable continuation state, request-boundary timing, tool-plan sequencing, and turn-level steer admission. Several surrounding policies already have named owners and are injected through interfaces. Therefore the goal is **partly met today**: explicit capabilities exist for compaction and request preparation, and standalone policy owners exist for budgets, guards, retries, approvals, and provider continuity. The remaining opportunity is to narrow the loop's ownership of steer mail, tool-call plans, and request accounting without hiding execution order behind generic callbacks.

Evidence: `ApplicationRunLoop` (`source/services/agent-runtime/application-run-loop.ts`) owns `RunState`, `EventQueue`, `#execute`, `#dispatchToolCalls`, `#settleToolPlan`, and public turn/steer methods; its options already include `ApplicationRequestPreparation`, `ApplicationBoundaryCompaction`, and `onRequestBoundary`. `RunBudget` and `GenerationGuard` are separate modules. Approval batching and resolution are owned by `ToolApprovalBatchCoordinator` and `ApprovalDecisionExecutor`; provider chain/debt decisions are owned by `ProviderContinuity` and `SessionInputPlanner`. See Contracts 01, 02, 05, and 11 for the invariants to retain.

### God-object assessment

This is a god-object candidate by size, dependency count, and mixed ownership, but not every responsibility should leave it: request/response sequencing and request-boundary orchestration are its coherent domain. The design must avoid replacing it with a god orchestrator that wires a series of pass-through managers. An extraction earns its seam only if it owns durable state or a policy/invariant which would otherwise be repeated or remain distributed across callers.

## Concern inventory

Lifecycle labels: **request** means once per model request/boundary; **tool call** means tool plan admission, approval, execution, or settlement; **turn end** includes segment completion/abort and continuation. Cancellation refers to `AbortSignal`, `abortSegment()`, or `abort()` as applicable.

| Concern (evidence in `application-run-loop.ts`) | State/policy currently owned | Lifecycle hooks and cancellation interaction | Disposition |
| --- | --- | --- | --- |
| Model turn and request sequencing (`#execute`, `#run`; approx. 884–1533) | Ordered request construction, streamed-event consumption, response completion, request retry and rollback, turn count, terminal completion | Request boundary before each call; tool dispatch after complete response; continuation after tools. Segment signal aborts request and stream; retry waits are abortable; partial request output is rolled back before retry. | **Keep inline as orchestration.** It owns the sequencing domain. Extracting the whole loop would only rename it. Move a policy only when a separate owner can enforce it without replaying the sequence in callers. |
| Turn/segment lifecycle and steer mailbox (`openTurn`, `closeTurn`, `abort`, `abortSegment`, `steer`, `retractSteer`, `editSteer`, `#admitPendingSteers`, `#releasePendingSteers`; approx. 474–638) | `#turnOpen`, `#turnPaused`, `#runInFlight`, `#pendingSteers`, segment generation, active abort controller; admission/release fate and FIFO ordering | Admission at request boundary, including after async compaction; release at turn close/abort/superseding start; pending steers survive approval pause and retry gaps. `abortSegment` preserves them; `abort` releases them. | **Extract as a focused turn-input capability, after characterization.** It owns the cross-segment mailbox/admission policy and distinct abort semantics; this is more than a queue wrapper. Interface should expose offer/edit/retract, boundary drain, pause/resume, and end-turn settlement, with the loop retaining the precise boundary call. No persistence change: pending inputs remain in-memory and intentionally do not survive restart (Contract 12). |
| Approval continuation and per-response tool plan (`RunState.pendingApprovals`, `approvalDecision*`, `toolPlan`; `#dispatchToolCalls`, `#settleToolPlan`; approx. 1534–1742) | Tool calls/results in provider order; parsed params; approval-pending entries; `ApprovalLedger`; eligibility and contiguous parallel groups; execution result and terminal-tool behavior | Tool-call planning occurs after completion; staged approvals pause the segment; continuation applies one decision then resumes the retained plan; result append precedes next request. Run cancellation passes through each invocation's signal; never-dispatched work remains subject to effect-ledger aborted settlement, dispatched-but-unobserved to unknown. | **Extract a response-scoped tool execution capability.** It should own the planned-call state, ordered contiguous batch formation, invocation and tool lifecycle, approval-pending bookkeeping, and call/result settlement. Its interface should accept one completed ordered call set and provide resumable pending approvals/results to the loop; avoid a generic `execute(action,payload)` API. Keep approval authority in existing approval services and `ApprovalLedger`; the new owner may request/consume decisions but must not decide policy. This is the largest extraction and should follow the mailbox and characterization work. |
| Tool approval authority (`ApprovalLedger`, `needsApproval`, pending interruption; tool-invocation context; approx. 1534–1618) | Already-taken per-call approvals/rejections and denial message, interruption correlation | Per-call before execution; decisions received between segments and applied on continuation; cancellation does not turn pending authority into approval. Approval services remain the external decision authority. | **Already partly extracted; keep authority inline only as the adapter between retained plan and `ApprovalLedger`.** The tool-plan capability above may own pause/continue state, but must call the existing authority. Contract 11 is draft with retained reds; do not make its violations appear repaired through this plan. |
| Tool execution lifecycle and effect observation (`#invokeTool`, `#notifyToolLifecycle`; approx. 1793–1840) | Attempt number, tool identity/context, dispatch-before-execute marker, before/after/error observations, conversion of ordinary exceptions to model-visible errors | One before/after/error lifecycle per actual invocation; dispatch marker occurs before body; cancellation and harness invariant failures propagate; ordinary errors become tool results. | **Keep the lifecycle port and error semantics; transfer execution implementation with the tool-plan owner.** `ToolExecutionLifecyclePort` is already an explicit seam. Keep `getOnToolDispatch` and the effect ledger as current owners; do not duplicate settlement policy. |
| Run budgets and run-level containment (`RunBudget`, `#evaluateRunBudget`, `#emitRunBudgetEvent`, `#pauseForRunBudgetInteraction`, `grantRunBudgetExtension`; approx. 516–553, 1873–1927) | `RunBudget` owns measured budget/stall state; loop owns its integration with request/tool boundaries, pending interaction, grants, and critical wrap-up state | Evaluate after request and result/cost evidence; pause before next request/tool; approval continuation resumes same budget; segment end pauses clock; cancellation ends segment. Extensions are charged in the loop on continuation, with an interactive grant marked consumed to avoid double charge. | **Already extracted policy; keep integration inline.** Do not move grant charging or escalation decisions to UI/adapters: unattended continuation must stay finite. Contract 05 and `run-budget-stall-escalation.md` are authoritative. |
| Generation guards and deadlines (`GenerationGuard`, `GenerationStreamDeadlines`, `ToolArgumentRunawayGuard`; approx. 1095 onward in `#execute`) | Guard classes own thresholds/evidence; loop constructs them per request and binds abort actions | Per request, dispose timers/guards in `finally`; request-level timeout can abort one request; segment signal cancels all. Retry/recovery classification decides if a failure retries. | **Already extracted; keep per-request wiring inline.** The loop is the owner of the request scope, while guard policy lives in guard classes. Contract 05 forbids changing abort/settlement semantics as part of structural extraction. |
| Context compaction and request-boundary advice (`ApplicationBoundaryCompaction`, `onRequestBoundary`; approx. 973–1034) | Compactor owns local algorithm and cost/history replacement; loop owns safe placement, item/history replacement, chain reset, event forwarding, and steer admission around async work | At request boundary, before model dispatch; compaction receives signal and can emit started/completed/failed; newly arrived steer is admitted after replacement. Cancellation must not leave a partial replacement or lose pending steer. | **Already an explicit capability; retain.** Keep the small interface and loop sequencing. Do not fold provider-native compaction into local compaction; both have distinct owners. |
| Provider request preparation (`ApplicationRequestPreparation`; approx. 1260–1270) | External request preparation/observation context, retained through continuations | Immediately before each dispatch; `run()` scopes async request operation; continuation may refresh closure. Segment abort travels on the request signal. | **Already extracted; retain.** No second request wrapper. |
| Provider continuity and chain safety (`responseId`, `responseProviderId`, `currentProviderId`, `disableChainingForAttempt`; `startStream`, `continueRunStream`, request build, `finish`) | Loop stores provider response anchor and enforces same-provider/supported-chain checks; `ProviderContinuity`/`SessionInputPlanner` own session-level chain and debt/replay policy | Per request and continuation; drop opaque ID on provider mismatch or unsupported chaining; chain-recovery disable is one-shot. Abort/failure recovery and full-history rebuilding remain in session/recovery owners. | **Already partly extracted; keep the local provenance gate inline.** Do not migrate chain/debt policy into a loop capability. Contract 02's complete tool-pair/debt invariants and provider-specific semantics remain authoritative. |
| Usage and request cost accounting (`#nextRequestId`, `#appendCostRecord`; approx. 1841–1872) | Process-wide unique IDs; normalized usage, pricing version, per-run accumulated cost records; failed/cancelled requests get partial records | Allocate immediately before dispatch; settle on terminal success or error; emit live cost only on event queue, never provider history; preserved over approval continuation. Budget consumes records at boundaries. | **Extract only if cost-accounting rules need another consumer; otherwise keep local for now.** A future `RunRequestAccounting` seam is justified by process-wide ID uniqueness and pricing/settlement policy, not line count. Avoid splitting before the tool/lifecycle work clarifies the orchestration state. |
| Decision-shadow failure observation and diagnostics (`#observeDecisionShadow`, `#observeTerminalFailure`, `logDiagnostic`) | Observer isolation and best-effort diagnostics; no execution decision | Failure/diagnostic events at request or tool lifecycle; observer/diagnostic exceptions are swallowed; cancellation remains primary. | **Already an observer port; keep small delivery wrappers local.** Observation must remain non-interfering. |
| Input/output normalization and provider-neutral representation (`normalizeInput`, `normalizeHistory`, `normalizeApplicationInput`, `toModelTools`, result serialization, opaque items) | Conversion and history representation needed to maintain provider-facing call/result ordering and multimodal payload shape | Every request, call/result, retry rollback, completion, and continuation. Never erase a call/result pair or pass opaque state across provider ownership. | **Keep current representation logic local until a separate cohesive contract owner is demonstrated.** Helpers are not by themselves policy modules; Contract 02 governs chain/effect settlement and opaque state. |

## Target shape and resulting loop skeleton

```ts
class ApplicationRunLoop {
  // Owns one model-turn's request/response sequencing and safe boundary timing.
  startStream(agent, input, options) { return this.runState.start(agent, input, options); }
  continueRunStream(handle, options) { return this.runState.resume(handle, options); }

  async execute(state, signal) {
    while (true) {
      await this.budget.beforeRequest(state);       // current RunBudget policy
      await this.turnInput.admitAtBoundary(state);  // mailbox policy; ordered before compaction/request
      await this.compaction.atBoundary(state, signal);
      const response = await this.request(state, signal); // retries, guards, preparation
      if (response.toolCalls.length > 0) {
        const pending = await this.toolExecution.settle(response.toolCalls, state, signal);
        if (pending.approval) return this.pauseWithContinuation(state, pending);
        if (pending.terminal) return this.finish(state, pending);
        continue;
      }
      if (response.isTerminal) return this.finish(state, response);
    }
  }
}
```

This is a responsibility sketch, not a proposed generic capability registry or a literal new API. `ApplicationRunLoop` remains the explicit composition/wiring point for the small, known capabilities. Each capability owns its stateful policy and exposes a narrow lifecycle interface; it does not receive a catch-all `RunState` merely to shorten signatures. Keep turn boundary ordering visible in the run loop because moving those calls behind opaque callbacks would make correctness harder to verify.

## Proposed interfaces and state ownership

1. **`TurnInputMailbox`** owns pending user/system injections and their IDs/outcomes. Candidate interface: `offer(items, id?)`, `edit(id, items)`, `retract(id)`, `admitAtRequestBoundary(append)`, `pauseSegment()`, `resumeSegment()`, `endTurn(reason)`. It must distinguish segment abort from turn abort; the run loop invokes admission exactly after completed tool results and after compaction replacement. No persistence migration: the current queue is ephemeral.
2. **`ToolCallExecution`** owns the ordered response tool plan, approval-pending plan entries, parameter preflight, eligibility decisions, contiguous parallel grouping, invocation lifecycle, and ordered call/result emission. Candidate interface: `plan(completedCalls, context)`, `resume(approvalDecision, context)`, and a result (`completed | approvalPending | terminal`) containing only the next observable events/continuation needed by the loop. It does not own approval authority, effect ledger state, tool registry, or provider transcript policy; inject those existing interfaces. Avoid exposing mutable `RunState` or requiring callers to manually coordinate individual tool steps.
3. **Existing capabilities remain distinct:** `ApplicationBoundaryCompaction`, `ApplicationRequestPreparation`, `RunBudget`, `GenerationGuard`, retry classification, `ToolExecutionLifecyclePort`, `ApprovalLedger`, `ProviderContinuity`, and `SessionInputPlanner`. No umbrella `RuntimeCapabilities` bag until there is a real consumer need; explicit constructor composition is preferable.

## Incremental milestones

### M0 — Characterize the current contracts (test-only)

- Add/confirm tests for steer FIFO/admit/edit/retract/release across pre-run, request boundary, compaction await, approval pause/resume, retry gap, segment abort, and turn abort.
- Add/confirm tests for ordered tool call/result pairing, contiguous-only parallel batches, approval-pending continuation, one-time lifecycle hooks, and cancellation before/after dispatch.
- Record the existing narrow test commands and compare against a pristine worktree. No source change; no persistence change.
- **Contracts:** 01 (steer settlement); 02 (pair/order/effect state); 05 (cancellation/guards); 11 (approval authority, including retained reds). Provider black-box baseline is required before later run-loop/provider-behavior changes.
- **Preservation:** tests pin current behavior before moving ownership; expected-failure Contract 11 cases remain expected failures and are not silently flipped.

### M1 — Extract turn input mailbox

- Move pending steer state and its offer/edit/retract/admit/release decisions behind `TurnInputMailbox`; keep boundary timing and the call to drain it visible in `ApplicationRunLoop`.
- Leave application-facing methods compatible while callers are migrated. Ensure `abortSegment()` preserves queued entries and `abort()`/`closeTurn()` settle them exactly once.
- **Validation:** focused run-loop and agent-client lifecycle tests; `pnpm test:related ./source/services/agent-runtime/application-run-loop.ts` if source path selection applies; `pnpm test:changed`, `pnpm typecheck`. Since run-loop behavior is touched, also `pnpm test:provider-black-box` per AGENTS.md/testing skill.
- **Contracts:** 01 changes owner detail from loop to mailbox but no invariant or public settlement change; 05 documents segment-vs-turn cancellation ownership. No on-disk migration; restart continues to discard pending in-memory steers.
- **Preservation:** use Contract 01 boundary tests and verify both `abortSegment` and turn-level `abort`; keep admitted messages in ordinary user-message history and in their established order.

### M2 — Extract response-scoped tool execution plan

- Move completed-response tool preflight/planning, retained approval-pending entries, contiguous batching, invocation lifecycle, and ordered result settlement into `ToolCallExecution`.
- Keep approval decisions in `ToolApprovalBatchCoordinator`/`ApprovalDecisionExecutor` and `ApprovalLedger`; keep durable effect status in `ToolExecutionLedger`; keep request/response loop and request boundary in `ApplicationRunLoop`.
- Preserve continuation handles for already-created segments. If plan object shape changes, add a versioned/internal compatibility decoder for old in-memory handles; serialized session files contain canonical history/events, not executable continuation closures. Verify actual persistence boundary before implementation; do not add a durable schema migration unless evidence shows plans are persisted.
- **Validation:** focused `application-run-loop` tool/approval/parallel tests, tool ledger/effect settlement and approval tests; `pnpm test:changed`, `pnpm typecheck`; `pnpm test:provider-black-box` because tool/approval resume and run-loop dispatch behavior are affected. Broaden to `pnpm test` only if the extraction changes broadly imported behavior; justify before launch per AGENTS.md.
- **Contracts:** 02 updates implementation owner only, preserving C2.1–C2.7 and failure settlement; 05 preserves C5.1/C5.6 cancellation and dispatch semantics; 11 must remain unchanged as a separate audit contract (including current retained reds). No provider wire or persisted-history changes.
- **Preservation:** keep the same provider transcript ordering, call/result IDs, approval interruption shape, cancellation propagation, lifecycle event order, contiguous parallel eligibility, and terminal-tool behavior. Compare black-box approval-resume and partial-stream failure cases.

### M3 — Reassess request accounting; defer unless a second real consumer exists

- Inspect actual `ModelRequestCost` consumers. Extract a narrow accounting owner only if cost ID allocation/settlement policy is shared or independently testable beyond the loop; otherwise explicitly retain it as loop-local.
- If extracted, its interface must make request identity, completion/failure/cancellation, usage normalization and duplicate-safe emission explicit. Do not let it own budget judgment, provider retry, or session persistence.
- **Validation:** focused cost/pricing and run-budget tests, `pnpm test:changed`, `pnpm typecheck`; no provider black-box rerun unless dispatch/event behavior changes. Contracts 05 (budget input) and 07 (logging/provider traffic) change only if cost-event semantics change. Preserve process-wide request-id uniqueness and event-queue-only cost updates.

## Cross-task contracts

- **T1 event-sourced session + provenance:** this design assumes no change to canonical event types, durable tool-call/result pairing, turn identity, or replay ownership. The new mailbox and tool execution plan are ephemeral execution state, not durable journal events. T1 may persist observed user/tool lifecycle events, but should not persist pending `ApplicationRunLoop` internals or continuation object graphs. If T1 introduces a different source for replayed `tool_started`/`tool_result`, this plan requires the same per-call IDs and unknown-vs-aborted effect settlement described in Contract 02.
- **T3 durable goal:** no dependency on T3 goal state or lifecycle. If goal metadata is threaded into a turn, pass it through existing invocation/turn context rather than adding goal policy to `ApplicationRunLoop`; this design neither defines goal events nor claims goals survive a restart.
- **Control socket M1b:** no dependency. The separately planned admission receipt in `ConversationOrchestrator.sendUserMessage` does not own or alter loop steer policy; loop admission remains at request boundaries and its outcome remains distinct from admission-time receipt.

## Open decisions for the user

1. **Extract both remaining seams or stop after mailbox?** Recommendation: M1 first, then require M0 evidence and review the M2 tool-plan seam against a concrete interface before authorizing its code. Tool planning may prove too coupled to provider history to deepen safely.
2. **Should cost accounting be a separate module?** Recommendation: defer M3 unless a second real consumer or test boundary exists; code size alone is insufficient.
3. **Should contract 11's current retained reds be addressed during M2?** Recommendation: no. This design is not authority to repair them; keep any repair separately authorized and independently validated.

## Unverified claims and known unknowns

- The working tree and source show `ContinuationHandle` wraps in-memory run state, while session durability uses canonical events/history. The exact compatibility surface for any in-flight continuation serialized by an external caller was not verified; M2 must check all continuation handle producers/consumers before changing shape.
- No ownership issue is claimed for hidden runtime/provider adapters beyond the inspected run-loop and cited contracts/plans. M0 must establish baseline behavior against current focused tests and black-box scenarios.
- Contract 11 is explicitly an audit draft with retained expected failures. Its open findings are not evidence that the run loop itself owns those defects.

## Resume here

Design is complete; implementation remains unstarted. Begin with M0 in an isolated worktree after authorization. Re-read Contract 01 (turn/steer settlement), Contract 02 (provider input/effect settlement), Contract 05 (guards/cancellation), Contract 11 (destructive approval authority), and the `run-budget-stall-escalation.md`, `parallel-safe-tool-dispatch.md`, `mid-turn-injection.md`, `chain-settlement.md`, and `provider-neutral-context-compaction.md` resumes. Keep the high-level request/response lifecycle in `ApplicationRunLoop`; only extract owners whose state and invariants have a demonstrably simpler seam.
