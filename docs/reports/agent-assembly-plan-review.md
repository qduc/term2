# Agent assembly plans: source-alignment review

**Artifact types:** architecture (design), plan (implementation and verification).
**Budget:** standard — six sequential lenses over three linked migration plans.
**Verdict:** no remaining material issues found within the reviewed scope.

## Scope and assumptions

Reviewed October 18, 2026 against production source at
`143645d1e2ae50c4e831b187985721c499ad430d` and the uncommitted plan bytes identified
below. The source/package diff against that commit was empty. The migration remains
paused; this review authorizes no implementation. Assumed goal: preserve current
product behavior while changing composition, with existing trusted in-process code
and current workloads. No new performance, scale or availability claims were made.

This was the plan author's review, using sequential passes rather than independent
agents. It is not the separate verifier acceptance required for future high-risk
production slices. No runtime behavior checks were executed for this docs change.

## Corrections inspected

- Design now distinguishes existing public observational hooks from proposed
  internal transformation/decision hooks. Implementation preserves adapters and
  call placement; verification covers privacy, ordering, correlation, deduplication,
  failure/timeout isolation and shutdown.
- Design and implementation name child construction and scoped policy alongside
  root construction. Verification includes role selection, root-only kill switches,
  host-scope cases and approval/parallel/termination metadata.
- Design sketch delegates batching to `ToolCallExecution` rather than awaiting
  tools serially. Implementation and verification preserve eligibility, barriers,
  caps, plan-order acceptance, fulfilled siblings before propagating rejection,
  and settlement before the next provider request.
- Proposed default handlers cannot add new product policy. Existing public
  tool completion/error notifications remain before batch result acceptance.

## Evidence inspected

| Contract | Source symbols |
| --- | --- |
| Public API and adapter | `Term2Hooks` in `source/services/hooks/hook-contracts.ts`; `createToolExecutionLifecyclePort` in `source/services/hooks/hook-tool-lifecycle.ts` |
| Observer loading, ordering and isolation | `HookService` in `source/services/hooks/hook-service.ts`; `HookRegistry.dispatch` and `#dispatchOne` in `source/services/hooks/hook-registry.ts`; `docs/public-hooks.md` |
| Root selection | Effective capabilities, group kill switches and web factory calls in `source/agent.ts` |
| Child selection and scope | `SubagentToolFactory.buildToolDefinitions`, `SubagentToolPolicy.wrapNetworkToolWithScope` in `source/services/subagents/tool-policy.ts`; child assembly in `source/services/subagents/runtime.ts` |
| Parallel execution and error paths | `ToolCallExecution.plan`, `resolveApproval`, `settle`, `#invoke`, `#notify` in `source/services/agent-runtime/tool-call-execution.ts` |
| Advancement and acceptance | `ApplicationRunLoop.#runTurn` and `#toolCallContext`; `SessionTurnAdapter` acceptance callbacks; `ConversationRecord.markDispatched`, `acceptObservedItem` and `acceptSegment` |
| Cleanup and entry paths | Session composition `dispose`/`shutdown`; `createConversationRuntime`; interactive CLI and non-interactive runtime construction |

## Review passes

Each pass tested the negation of three candidate assumptions before reaching its
stopping condition. No medium-or-higher findings survived the final judge pass.

| Lens | Assumptions tested | Result and coverage |
| --- | --- | --- |
| P1 Assumptions | Public hooks can transform calls; root and child policies coincide; tools execute serially. | Rejected all three against source; revised plans explicitly preserve the different contracts. Major premises covered. |
| P2 Failure paths | Observer failure aborts execution; sibling rejection may discard fulfilled results; disposal may close borrowed services. | Observer isolation and concurrent settlement are explicitly preserved; ownership/partial-startup checks remain required at affected slices. Failure boundaries covered at plan level. |
| P3 Consistency | Proposed hook timing matches public timing; new handlers may change defaults; verification may ignore unchanged affected callers. | Separate contracts and default-inert behavior are explicit; affected evidence follows callers rather than edited filenames. Cross-plan dependencies checked. |
| P4 Omissions | Every design requirement has an implementation step; every changed boundary has evidence; postponed choices have a resolution point. | Mapped composition/lifetimes to steps 2–3, hooks/concurrency to step 4, default adoption to step 5 and verification matrix. Required coverage present. |
| P5 Adversary | Raw factories can replace scoped tools; a replacement may fabricate physical execution; prototype success can stand in for production. | Plans prohibit these shortcuts and require final-effect authorization and production evidence. Trust/acceptance scan complete. |
| P6 Proportionality | A DI framework is mandatory upfront; a global baseline is required first; nested coordination is required. | Plans defer mechanisms to demonstrated slice needs, scope baselines to affected claims and keep one implementing owner. Every major step maps to the stated goal. |

## Checks and limits

Focused Prettier checks passed for the three plans. Local Markdown file targets
and cited key symbols were checked against the checkout. Diff whitespace check
passed. These checks establish document consistency and source alignment; they do
not prove the future migration preserves behavior. Concrete hook signatures,
framework choice, first slice and runtime acceptance remain decisions/evidence for
implementation. Human assessment of assembly ergonomics remains open.

## Correction retrospective

The original split inherited a handoff's broad ownership map and used formatting
and link checks without tracing the three execution boundaries. This was a
preventable missing source check, not a runtime defect. All three sibling plans
were inspected and corrected. The implementation plan now names the specific
source owners to inspect before extraction, and the verification matrix requires
public-hook, child-policy and concurrent-failure evidence. No skill or runtime
mechanism was changed, and no broader workflow-improvement claim is made.

## Reviewed plan identity

SHA-256 binds this report to the reviewed document bytes:

- `agent-assembly-migration.md`: `792551cdc1e37865ede9f13083240913aaa303e6364e8a626e41c6becf4bfb6d`
- `agent-assembly-implementation.md`: `b5f6a2f7f1933832a60def347ec4bf73a840d85b036df0a044daae6cb7e9b3b9`
- `agent-assembly-verification.md`: `56748777b6a131f2a4a993dbd99dafc8a5ee5ba840ba5f4d3d26836671d10898`
