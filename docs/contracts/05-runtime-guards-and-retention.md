# Contract 05 — Runtime guards and retention

Status: **owner-reviewed 2026-08-14; focused command green. The one red product
defect was repaired in Phase 2 on 2026-08-15; its residual ambiguous case is an
approved deferral recorded in §10.** Owners: the guard
inventory and contracts recorded in [`docs/plans/guard-ledger.md`](../plans/guard-ledger.md)
plus the linked owner plans (`run-budget-stall-escalation`, `tool-output-and-effect-safety`,
`chain-settlement`, `background-shell-monitor`, `provider-neutral-context-compaction`).
This record names the contract-level invariants and the deterministic matrix;
the ledger remains the authoritative per-guard inventory.

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C5.1 | Admission limits reject only new work and leave admitted work untouched. | A guard that aborts already-admitted work (lost output, killed turns) or admits beyond the bound (runaway resource use). |
| C5.2 | Retention bounds remove only state proven dead, or preserve omitted material through a retrieval path. | Evicted state that the user still needs with no way to retrieve it; unbounded retention growth. |
| C5.3 | Inactivity watchdogs observe meaningful activity at their named boundary. | A transport killed while genuinely alive (proxy stalls, slow-but-live streams) or a dead transport never detected. |
| C5.4 | Containment budgets remain finite and use staged escalation where authorized. | A runaway run consuming unbounded tokens/time; an abrupt kill where a staged warn-then-stop is authorized. |
| C5.5 | Security and authority boundaries stay fail-closed. | A sandboxed command reaching the network, home files, or protected paths; a dangerous command auto-approved. |
| C5.6 | Every destructive action is justified by direct evidence, settles partial work truthfully, and reports a typed recovery classification. | A guard kills a run and fabricates "completed"; partial work is silently dropped; a possibly-executed effect is re-run blindly. |

## 2. Owners

- **Enforcement:** per-guard owners from the ledger (run budget -> `RunBudget`
  in the run loop; command safety -> `validateCommandSafety`; sandbox ->
  `createSandboxRuntimeConfig`; shell containment -> `ExecuteShellOptions` +
  `boundToolResultText`; background shell -> `BackgroundShellRegistry` +
  `BackgroundShellOutputStore` + watches; steering -> `SubagentRunControl`
  mailbox; WebSocket liveness -> `websocket-receive-watchdog`; tool ownership ->
  `ToolOwnershipRegistry`; repetition/containment -> `GenerationGuard`/
  `ApplicationRunLoop`). The ledger's numbered inventory
  (`guard-ledger.md:559-587` and its repair dispositions `:111-153`, `:270-347`,
  `:368-433`, `:469-541`) is the authoritative map.
- **Recovery:** retry/recovery policy (`DefaultRecoveryExecutor`, retry
  classifier), ledger settlement on stream failure, background-shell
  cancellation settlement, watchdog -> HTTP fallback where authorized.

## 3. Execution paths that share the contract

- Root interactive runs; child runs (nested/async/mentor, run-budget clamp);
  workflow runs; non-interactive / unattended continuation
  (`--auto-approve`); shell foreground and background paths; provider transport
  (WebSocket receive); every shared-utility guard (output bounding, steering
  mailbox, tool ownership).

## 4. Identities and state crossing the boundary

- Typed failure/classification surfaces: `ToolExecutionStatus` `'unknown'`
  (outcome-unknown, not failed); `BackgroundShellRegistryCapacityError`;
  `mailbox_full` typed non-success; `GenerationGuardError { code:
  "repetitive_text", unsafeToReplay: true }` (formerly); `DeniedReadInfo
  { path, suggestedParent, sensitive }`; `RunBudgetEvent` `budget_stage` /
  `tool_stall`.
- State that must survive a guard action: admitted-but-paused work (queue,
  retained background jobs), tool-ownership claims (released only on proven
  settlement), dropped-count counters (`droppedBytes`, `droppedLines`), and
  truncated output tails (spool note + retrieval path).

## 5. Settlement semantics

- **Success:** a guard that permits work leaves that work with its original
  owner; for example, the background-shell registry creates a `running` job
  only after admission checks, then its settlement promise records the terminal
  outcome (`background-shell-registry.ts:173-202`). A receive watchdog resets
  its timer on each frame and closes its resources when the stream completes
  (`websocket-receive-watchdog.ts:47-91`).
- **Failure:** a tripped guard reports its own typed failure where that owner
  defines one (for example, capacity/disposal errors or watchdog timeout),
  aborts only the work it owns, and leaves recovery classification to the retry
  boundary. A generation-guard trip is an `AmbiguousModelOutcomeError`, so it
  is explicitly unsafe to replay (`generation-guard.ts:63-71`).
- **Reject new work:** steering mailbox rejects the new message before
  enqueueing (`guard-ledger.md:276-282`); background registry throws capacity
  error on new launch (`background-shell-registry.test.ts:120-126`); parallel
  tool width defers, never rejects (`guard-ledger.md:113-127`).
- **Retention:** output store evicts oldest complete records only above cap and
  reports dropped counters (`background-shell-output-store.ts:251-288`); settled
  background jobs evict FIFO only after `close` (`:168-199`);
  `boundToolResultText` spools with a retrieval path (sole "verified safe" row,
  `guard-ledger.md:570`).
- **Cancellation:** background shell `cancel` -> `cancelling` -> `cancelled`
  with `stop_requested`; disposal rejects new work (`background-shell-registry.test.ts:139-163`).
- **Watchdog:** first-frame (90s) / inter-frame (600s) expiry aborts with typed
  errors; external abort is preserved, not rewritten (`websocket-receive-watchdog.ts:40-60`).
- **Retry:** retryable failures do not settle an effect as successful first.
  The recovery executor clears provider continuity, settles open tool calls as
  `aborted` or `unknown`, restores completed ledger entries, then starts the
  next retry attempt (`recovery-executor.ts:60-89`). Watchdog timeout errors
  classify as retryable; an unrecoverable or exhausted retry follows the
  terminate path instead (`retry-error-classification.ts:365-455`,
  `recovery-policy.ts:5-48`).
- **Destructive settlement:** stream failure settles never-dispatched as
  `aborted` and dispatched as `unknown`; `terminate` clears continuity and
  emits `tool_recovery` with recovered/dropped IDs (`recovery-executor.ts:93-130`).
- **Ambiguous:** `unknown` never counts as failure and never invites blind
  re-execution (`tool-output-and-effect-safety.md:31-40`).

## 6. Observability

- Security: `logger.security("Classifying command safety")`, `"Command
  classification result"`, `"Command validation: needs approval"`
  (`command-safety/index.ts:53-80`, `:331-367`); `onProtectedFiltered`
  callback for filtered write paths (`sandbox-policy.ts:525-530`).
- Run budget: `RunBudgetEvent` `budget_stage`/`tool_stall` with evidence
  (`run-budget.ts:64-82`); soft/warning/critical stages and stall counts.
- Background shell: `background_shell_started` / `background_shell_completed`;
  every read returns `droppedBytes`/`droppedLines`
  (`background-shell-output-store.ts:201-241`).
- Watchdog: distinguishable `"WebSocket first frame timeout"` /
  `"WebSocket idle timeout"` errors, classified retryable
  (`retry-error-classification.test.ts:171`).

## 7. Public boundary under test

- `validateCommandSafety` + specialized handlers — `command-safety*.test.ts`.
- `createSandboxRuntimeConfig` + `isPathProtected` + `DeniedReadDetector` —
  `sandbox-policy.test.ts`, `denied-read-detector.test.ts`.
- `RunBudget` policy/stages/stall/extensions — `run-budget.test.ts`,
  `application-run-loop.run-budget.test.ts`.
- `ExecuteShellOptions` timeout/overflow — `execute-shell*.test.ts`.
- `BackgroundShellRegistry` / `BackgroundShellOutputStore` —
  `background-shell-registry.test.ts`, `background-shell-output-store.test.ts`.
- `WebsocketReceiveWatchdog` — `websocket-receive-watchdog.test.ts`.
- Steering mailbox — `subagent-run-control.test.ts`.
- `ToolOwnershipRegistry` — `tool-ownership-registry.test.ts`.

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence (file:title) | Status |
| --- | --- | --- |
| Threshold minus one | `background-shell-output-store.test.ts:125` "retains an unterminated chunk one byte below the byte cap without eviction"; `run-budget.test.ts:90-103` "reports byte-identical non-mutating calls once and resets the sequence after a mutating call" keeps calls 1–2 below the stall threshold silent | covered |
| Exactly threshold | 16 retained bytes at `maxBytes:16` (`background-shell-output-store.test.ts:74-82`); USD exactly 100 at limit 100 -> soft+warning+critical (`run-budget.test.ts:62-76`) | covered (per-guard) |
| Threshold plus one | second concurrent job at cap 1 rejected (`background-shell-registry.test.ts:120-126`); byte overflow evicts oldest with counters (`background-shell-output-store.test.ts:83-94`); stall 3 emits (`run-budget.test.ts:101-103`); mailbox fifth message -> `mailbox_full` (`guard-ledger.md:334-347`) | covered |
| Genuine harmful case | `find` destructive flags RED (`command-safety.find.test.ts:131-145`); watchdog first-frame stall -> typed timeout; runaway retention containment (`guard-ledger.md:289-295`) | covered |
| Legitimate work resembling the harmful signal | safe `find` operations GREEN (`command-safety.find.test.ts:8-55`); read-only git commands GREEN, destructive YELLOW (`command-safety.git.test.ts:5-93`); red false-positive proofs for valid periodic output (`guard-ledger.md:232-244`) | covered |
| Cancellation | background registry cancel + reject-after-disposal (`background-shell-registry.test.ts:139-163`); run-budget stopped interaction (`application-run-loop.run-budget.test.ts:138-159`); recovery terminate | covered |
| Retry | recovery executor `retry_fresh` cases (`recovery-executor.test.ts:109-353`); watchdog timeouts retryable (`retry-error-classification.test.ts:171`) | covered |
| Fallback | `initial-turn-recovery-handler.test.ts` `it.fails("characterizes the unimplemented watchdog timeout fallback at the initial-turn recovery boundary")` retains the intended `retry_fresh` / `full_history` assertion; the real `AmbiguousModelOutcomeError` path currently returns `terminate` | **PRODUCT DEFECT** — see §10 |
| Ambiguous outcomes | `unknown` settlement (`recovery-executor.test.ts:199`, `:244`; `tool-output-and-effect-safety.md:75-91`) | covered |
| Shared root path | run-budget root envelope unchanged (`run-budget.test.ts:164-167` "returns the child envelope unchanged at the root") | covered |
| Child path | run-budget clamp to tighter envelope (`run-budget.test.ts:169-181`); critical subagent wrap-up (`application-run-loop.run-budget.test.ts:161-186`); `subagent-async-registry.test.ts:592-615` "releases shared-session admission after %s terminal settlement" releases capacity after both failure and cancellation | covered |
| Workflow path | `run-agent-workflow.test.ts:37` "enforces the maxRuns guard at the run_agent_workflow tool boundary" rejects the second run while retaining the first result | covered |
| Non-interactive path | `non-interactive.test.ts:812` "runNonInteractive auto-approves only the finite parent run-budget extensions" stops after the configured parent extensions; `application-run-loop.run-budget.test.ts:103-136` covers the underlying unattended continuation | covered |
| Shell path | timeout/abort (`execute-shell.test.ts:40`, `:112`); network-approval timer pause (`execute-shell.network-approval-timeout.test.ts:24-142`); command-safety suite | covered |

## 9. Verification commands

Focused (verified 2026-08-14, including the retained expected-failure
characterization in §10):

```sh
NODE_ENV=test pnpm test \
  source/utils/shell/command-safety.test.ts \
  source/utils/shell/command-safety.find.test.ts \
  source/utils/shell/command-safety.git.test.ts \
  source/utils/shell/command-safety.path.test.ts \
  source/utils/shell/command-safety.red-yellow-policy.test.ts \
  source/utils/shell/command-safety.specialized-handlers.test.ts \
  source/utils/shell/command-safety.evaluator-false-positives.test.ts \
  source/utils/shell/sandbox/sandbox-policy.test.ts \
  source/utils/shell/sandbox/denied-read-detector.test.ts \
  source/services/agent-runtime/run-budget.test.ts \
  source/services/agent-runtime/application-run-loop.run-budget.test.ts \
  source/utils/shell/execute-shell.test.ts \
  source/utils/shell/execute-shell.network-approval-timeout.test.ts \
  source/services/shell/background-shell-registry.test.ts \
  source/services/shell/background-shell-output-store.test.ts \
  source/providers/websocket-receive-watchdog.test.ts \
  source/services/subagents/subagent-run-control.test.ts \
  source/services/approval/tool-ownership-registry.test.ts \
  source/non-interactive.test.ts \
  source/tools/run-agent-workflow.test.ts \
  source/services/subagents/subagent-async-registry.test.ts \
  source/services/retry/recovery-executor.test.ts \
  source/services/retry/retry-classifier.test.ts \
  source/services/retry/retry-error-classification.test.ts \
  source/services/retry/recovery-policy.test.ts \
  source/services/session/initial-turn-recovery-handler.test.ts
```

Result: **26 files / 423 tests passed / 1 expected failure (424 total).** (The Phase 0 baseline Seam 5 command
was valid — all nine of its paths exist — but under-covered the guard owners;
this command adds the run-budget, execute-shell, background-shell, watchdog,
mailbox, tool-ownership, non-interactive, workflow, async-admission, and
recovery-policy boundaries.)

Broader gates: `NODE_ENV=test pnpm test`, `pnpm typecheck`. A runtime-guard
change additionally requires a written guard contract and red
false-positive/true-positive matrix per `ROADMAP.md` Phase 3 Step 5, with the
`guard-ledger.md` updated.

## 10. Known gaps and classification

1. **Fallback recovery classification — repaired in Phase 2 for the provable
   half; the ambiguous half is an approved deferral.** The former
   expected-failure characterization in `initial-turn-recovery-handler.test.ts`
   is now two passing tests, one per side of the evidence line.

   Prerequisite (a), machine-readable unsent evidence, is satisfied by
   `providers/websocket-request-dispatch.ts`: the send path records `flushed`
   only for a frame written to an OPEN socket, `unsent` while the frame is
   still the client's, and `unknown` when the socket cannot be observed.
   Unrecorded requests read as `unknown`, so a missing record never authorizes
   a replay. Prerequisite (b) needed no new work — `transport_downgrade`
   already plans a bounded `retry_fresh` / `full_history` rebuild
   (`recovery-policy.ts:25-26`, `:60-65`).

   `CodexResponsesWSModel` raises the typed `UnsentWebSocketRequestError` only
   when three independent conditions hold: the failure is the watchdog's own,
   `frameCount === 0`, and the dispatch record is positively `unsent`. Each
   rules out one way of being wrong.

   **Approved deferral (owner: providers).** A timeout after the frame was
   flushed to an OPEN socket stays `AmbiguousModelOutcomeError` and still
   terminates. This is not a coverage gap but a property of the transport: the
   Responses WebSocket protocol offers no resume or idempotency signal, so
   "server never saw it" and "server accepted it and went quiet" are
   indistinguishable from the client. Replaying would risk a duplicated turn.
   Revisit only if the protocol gains a resume token or the SDK's
   `ResponsesWS` reconnect send-queue (`UnsentMessage[]`, `internal/ws.ts`) is
   adopted, which would widen the provably-unsent set without closing this
   case.

   The pre-existing string sniffing in `isDefinitelyUnsentWebSocketError`
   (`before opening`, `ECONNREFUSED`, `ENOTFOUND`) still serves non-watchdog
   connection errors. It is no longer load-bearing for the watchdog path and
   should not be extended; new unsent evidence belongs in the dispatch record.
2. **Ledger completeness limitation — non-gating.** The ledger itself states that keyword
   sweeps cannot find inline literal comparisons, so "every runtime guard" is
   bounded by the ledger's inventory, not by a proof of completeness
   (`guard-ledger.md:666-686`). Any new guard must be added to the ledger with
   its contract when introduced.
3. **Open design limitations — non-gating, uncharacterized hypotheses.** The
   background-shell watch budget remains unbounded
   (`background-shell-monitor/MAP.md:326-330`); there is no child-targeted
   run-budget grant API, mentor/async paths are unclamped, and siblings may
   exceed the parent remainder (`run-budget-stall-escalation-review.md:148-154`).
   These limitations remain classified hypotheses, not demonstrated product
   defects, until a public-boundary red proof is recorded.
