# Conversation record implementation

Status: implemented and verified on 2026-10-17. Target C with the acceptance contract tightened.

## Contract

Goal: keep the single model/tool loop while giving accepted conversation facts one authority; projection observes rather than accepting history or driving decisions.

Done checks:

- Record privately owns transcript, tool evidence and journal. No session caller combines or mutates these representations independently. Check imports, mutation sites and recovery paths.
- Runtime accepts response/tool facts before dispatch or subsequent requests. Projection no longer records tool evidence, commits history or supplies an execution continuation result. Check source and adversarial provider/approval/recovery journeys.
- Normal streaming, repeated decisions, steering, cancellation, provider recovery, compaction, background completion, rewind/import and rollover preserve existing behavior. Check provider black-box, integration, fake-Codex and appropriate e2e scenarios.
- Existing storage policies remain: a generic callback acknowledgement is not proof of fsync. Failure to record an effect cannot authorize replaying it. Check injected recording failure and completed-tool recovery.
- Typecheck, relevant static checks, formatting/lint and independent verification pass on the final change.

Constraints: preserve persistence formats, public conversation behavior, configured retry/budget policy and existing stop-proof gates. No permanent unit tests, no new execution owner, generic actor framework or universal write-failure stop policy. Preserve the primary checkout and other agents' work; implement in `.worktrees/conversation-record` and integrate after verification.

Authorized: remaining design exploration, implementation, reversible verification and local integration. No release or external publication.

## Resolved exploration

The current session persistence path catches conversation/journal sink failures. Critical gateway persistence has stronger acknowledgement semantics and remains separate. Acceptance therefore must not claim every callback return proves durability or introduce an unconditional fail-stop rule.

Projection currently mutates acceptance in stream callbacks and finalization. Conversation logging also repairs provider history by replaying log envelopes. All three mutation paths must move behind Record; wrapping the existing classes is insufficient.

Record owns consistency of accepted facts. Physical execution owners retain live jobs and stop evidence. Request construction and recovery policy remain outside Record.

## Evidence

Implementation and verification are complete. Local integration follows the verified commit.

### Implemented boundary

- `ApplicationRunLoop.#runTurn` remains the execution owner. Root session event delivery accepts facts synchronously before publication; actual tool dispatch has its own acceptance callback at the body boundary.
- `ConversationRecord` privately owns store, ledger and journal. It accepts input/items/dispatch, reconciles terminal history against a segment baseline, applies policy-selected recovery and performs coherent rewind/import/reset operations. Snapshot/export reconstruction is internal.
- `SessionStreamProcessor` is presentation only. `ConversationLogger` no longer replays logs to repair live history or records journal deltas. Completion and interruption callbacks explicitly obtain decisions after the stream view settles.
- Request-local runtime history/input views remain for provider serialization and approval suspension. Physical job registries, provider continuity, submission receipts and policy modules retain their existing contracts. This is a root session acceptance consolidation, not a repository-wide history rewrite.

### Exploration outcomes

| Question | Decision and evidence |
| --- | --- |
| Does a write callback prove durability? | No. Record reports memory acceptance and delivery acknowledgement/failure; existing session sinks continue after failure. Direct durable gates are unchanged. A throwing-sink probe confirms known evidence remains in memory. |
| Must rendering complete before evidence exists? | No. Runtime acceptance precedes publication, including journal deltas. Segment reconciliation removes duplicate append pressure without relying on logging. |
| Can dispatch be inferred from a UI event? | No. Batch display dispatch includes synthetic results. `acceptToolDispatch` runs at actual invocation, preserving unknown-versus-never-started recovery evidence. |
| What if a parallel sibling fails? | Settle every fulfilled result before propagating rejection. Independent red/green execution shows the baseline lost a known result and this implementation retains it. |
| Can Record simply wrap exposed owners? | No. Store/ledger/journal are constructed privately; callers no longer independently repair precedence. Presentation caches remain because they describe rendering. |

### Independent verification

Fresh agent `record_independent_review` did not implement the change and accepted the reviewed scope with no actionable regressions. It executed temporary real-module probes for acceptance-before-execution, mixed parallel rejection, throwing sinks, baseline reconciliation, reused IDs, compaction without logging, cancellation with a known result and cancellation with an unobserved result. The known-result cancellation probe observes one request, one tool execution, accepted completed output and no recovery or further request.

The parallel probe fails against `main`'s `ToolCallExecution`: the successful sibling remains `started` instead of `completed`. It passes here, and recovery leaves the rejected dispatched sibling `unknown`. Temporary baseline source was removed; no permanent unit tests were added. Original probe files were kept outside the repository under `/tmp/conversation-record-*-probe.ts` during verification.

An earlier temporary workflow probe also passed completed-effect recovery, dispatched/unstarted settlement, failed-sink acceptance, rewind pruning and reset. Source review covered native reasoning, recovery/import/undo and persistence wiring. Full command results will be recorded below.

### Bounded retro: known parallel result lost on rejection

Preventable, latent at least since `cf849370` extracted tool execution. `Promise.allSettled` collected every outcome, but an early throw discarded fulfilled siblings before the acceptance callback ran. Recovery therefore lacked a completed result that actually existed. The fix retains each fulfilled result in plan order before rethrowing a sibling failure; Record is now its one session acceptance authority.

| Check | Finding |
| --- | --- |
| Representability | Mixed settled outcomes are valid; rejecting the whole batch must not erase its fulfilled members. |
| Single source | Known outcomes now enter Record before recovery; presentation cannot supply a replacement authority. |
| Boundary | Fulfilled outcomes must cross acceptance before batch failure propagates. |
| Coupling | Previously depended on every sibling fulfilling before any result was recorded. |
| Assumption | One rejected promise was treated as if no useful outcomes existed. |
| Detection | Existing broad happy/error workflows did not combine a known successful tool and an invariant-rejected sibling; an independent injected mixed batch exposed it. |
| Automation | Types cannot establish this ordering alone. Temporary red/green execution supplies evidence under the no-permanent-unit-test policy. |
| Siblings | Searched runtime/session/retry for `allSettled` and `PromiseRejectedResult`; this is the only batch settlement site. Single-tool rejection has no fulfilled sibling to lose. |
| Knowledge | The accepted-evidence/physical-outcome distinction is explicit in the design and module callback ordering. |
| Observability | Recovery status distinguishes completed output from a dispatched unknown; the red/green probe observes that distinction. |
| Origin | Confirmed in extraction commit `cf849370`; no claim about an earlier origin. |

Structural prevention is the shared settlement-before-recovery path plus Record-owned evidence. No new guard, retry limit or persistence policy was introduced. Future changes to batch settlement still need mixed success/failure evidence; no claim of static prevention is made.

### Remaining limits

Passing fixture workflows and independent source review establish bounded behavioral evidence, not improved human comprehension. Live provider variability and every possible external crash timing are not exhaustively verified. Request-local transport synchronization and the existing distinction between cancellation, physical stop and durable settlement remain load-bearing complexity.


### Final command evidence

All commands ran in the isolated worktree on the final implementation:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass. |
| `pnpm lint` | Pass, zero errors; 31 existing warnings outside the changed source. Prettier passed. |
| `pnpm test` | 7 files, 28 static checks passed. |
| `pnpm test:integration` | 15 files passed, 1 file skipped; 121 tests passed, 1 skipped; 101.76s. |
| `pnpm test:provider-black-box` | Build passed; 24 files, 204 tests passed, 1 skipped; 121.80s. Includes actual CLI transport, approval, native reasoning, compaction/restart, crash-after-effect and repeated-decision/cancellation workflows. |
| `pnpm test:e2e` | 5 files, 31 tests passed; includes fake-Codex network workflows; 6.83s. |
| `git diff --check` | Pass. |
| Independent verifier | Accept; no actionable regressions in reviewed scope. |

The first integration run exposed an outdated test client shim: copying a stream
lost its private brand. The shim now constructs a branded stream and drives the
new acceptance/completion port; the actual background lifecycle assertions remain
unchanged. The focused scenario and final full integration suite pass.

Architecture skill edits only update factual symbol/ownership documentation; they
introduce no new agent method, orchestration capability or approval requirement.
