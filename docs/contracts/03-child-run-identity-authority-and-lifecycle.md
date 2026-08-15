# Contract 03 — Child-run identity, authority, and lifecycle

Status: **owner-reviewed 2026-08-14; focused command green.** Owner:
`createSubagentRuntime` and its strategy-specific runners (`SubagentAsyncRegistry`
for background, `NestedSubagentRunner` for foreground, `ExecutionSubagentRunner`,
`MentorRunner`), with event routing in `SubagentBridge` (`source/lib/subagent-bridge.ts`)
and provider traffic identity in session context (`session-context-service`).

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C3.1 | Every child run receives an identity distinct from the parent and stable across its own continuations. | Parent and child traffic/results conflated; a continued role run changes identity mid-session, breaking transcript and provider session attribution. |
| C3.2 | Foreground, background, adopted, mentor, evaluator, and nested-child events reach only their owning sink. | Notifications, approvals, or transcripts leak into the wrong sink; adopted work is shown as background before the transfer actually happened. |
| C3.3 | Global settings intended for children resolve consistently, while permissions and execution budgets may only stay equal or attenuate. | Privilege escalation: a child runs with parent approval powers, unsandboxed shell, or a larger budget than its parent. |
| C3.4 | Parent, turn, conversation, and explicit-user cancellation affect exactly the child scopes they own. | A parent turn abort kills surviving background work; an adopted run is cancelled by its detached old parent; session dispose strands children. |
| C3.5 | Every started child emits a truthful terminal state: completed, failed, cancelled, or interrupted. | The UI reports a cancelled run as completed (or vice versa); stop requests silently lost. |
| C3.6 | Admission failures preserve typed error codes and do not mutate running work. | Callers cannot distinguish failure causes; a failed admission disturbs active runs. |

## 2. Owners

- **Enforcement:** `SubagentAsyncRegistry` (async identity, admission,
  cancellation, settlement); `NestedSubagentRunner` (foreground identity and
  lease); `SubagentToolPolicy` (permission attenuation); run-budget clamping
  (`nested-runner.ts:408-425`); `SubagentBridge` (sink routing); traffic
  context derivation (bridge + registry).
- **Recovery:** bridge abort controllers and `dispose()`; registry
  `cancelAllRuns`/`disposeAndWaitForAdoptedLeases`; `ForegroundSubagentLease`
  detach/adopt; session composition disposal ordering
  (`session-composition.ts:717-754`).

## 3. Execution paths that share the contract

- Foreground runs (`runSubagent`), background async runs
  (`runSubagentAsync`), adopted transfers, mentor consultations, evaluator
  traffic, nested child-of-child runs.
- Continuation of persistent roles (`mentor`, `librarian`, `explorer`;
  `continue_run_id`).
- Cancellation: parent abort, turn abort, explicit stop, session dispose.
- Provider traffic identity for every child segment (launch, continuation,
  steering, nested children).

## 4. Identities and state crossing the boundary

- `runId` is the canonical identity; `name` is an optional active-run alias
  (`types.ts:211-219`). Async IDs are codenames (`calm-otter-42` pattern,
  `codename-run-id.ts:645`, `:681-693`). Foreground nested runs use the root
  tool-call id or a UUID (`nested-runner.ts:569-577`; test asserts
  `agentId === 'parent-call-1'`, `nested-runner.test.ts:419-436`).
- `role` (`explorer|worker|mentor|librarian`, `types.ts:6-10`) travels beside
  `runId` in handles/results/events.
- Session keys: role-scoped `role:${role}` for async mentor/librarian; UUID for
  other fresh runs (`subagent-async-registry.ts:218-223`). Continuations reuse
  the same `runId` + session + traffic context only for completed non-worker
  roles (`:191-217`).
- Traffic context: `providerHistoryKey: ${parentKey}:subagent:${scope}` with
  scope = tool call id / `'mentor'` / runId; nested children compose beneath the
  child key (`session-1:subagent:call-outer:subagent:call-inner`,
  `subagent-bridge.test.ts:340-370`).
- Approval authority: parent `ApprovalLedger` snapshot is replayed into a fresh
  nested ledger (`nested-runner.ts:95-98`, `:623-635`).

## 5. Settlement semantics

- **Terminal states:** `SubagentResult.status` =
  `'completed' | 'failed' | 'cancelled'` (`types.ts:155-161`); foreground
  `NestedSubagentResult` additionally `'interrupted' | 'running'` (`:196-209`).
- **Settlement:** registry settles exactly once (`run.settled` guard), removes
  the active name, and emits `subagent_completed` with `async: true`
  (`subagent-async-registry.ts:803-819`). If stop was requested, the terminal
  status is forced to `cancelled` while evidence is retained (`:852-875`).
- **Retry:** retry is an in-flight segment transition, not child settlement.
  `ExecutionSubagentRunner` forwards each retry event with the same `agentId`
  (`execution-runner.ts:354-365`); the async registry records it as a
  `retrying` observation and remains waiting on the provider
  (`subagent-async-registry.ts:490-498`). The run keeps its `runId`, session,
  and traffic context, and emits no `subagent_completed` until a later segment
  succeeds, fails, or is cancelled. A retry that cannot recover becomes the
  ordinary terminal `failed` result (unless the signal was aborted, which is
  `cancelled`), rather than a separately settled retry result.
- **Ambiguous outcome:** no child-result `unknown`/`ambiguous` terminal state
  exists. At the shared recovery boundary, `AmbiguousModelOutcomeError` is
  explicitly non-retryable (`retry-error-classification.ts:336-347`), so it is
  not replayed. The child runner receives the resulting terminal error and
  settles the child as `failed` (or `cancelled` for an abort-like error);
  effect-level `unknown` settlement for dispatched-but-unobserved tool calls
  remains the child session's tool-ledger responsibility, not a child lifecycle
  status (`recovery-executor.ts:60-80`). A child-specific ambiguous settlement
  policy is therefore **N/A** in the current result union.
- **Cancellation scopes:** foreground work aborts with the turn
  (`subagent-bridge.ts:209-235`); background work survives ordinary turn abort
  via `backgroundSignal` (`:347-371`); parent-signal abort cancels the run
  (`subagent-async-registry.ts:271-277`, `:639-645`); adoption detaches the
  parent abort listener (`foreground-subagent-lease.ts:68-87`, `:109-118`);
  session dispose cancels background, then awaits adopted settlements before
  detaching sinks (`session-composition.ts:717-754`).
- **Admission:** typed `SubagentRegistryErrorCode` =
  `'not_found' | 'role_mismatch' | 'not_continuable' | 'already_active' |
  'worker_blocked' | 'evicted' | 'invalid_name' | 'name_in_use'`
  (`subagent-async-registry.ts:36-53`); validation happens before
  `lease.adopt()` so a rejected adoption leaves foreground ownership intact
  (`:300-324`).
- **Interrupted (foreground only):** a nested run paused at an approval
  boundary emits `subagent_interrupted` and no completion; the async path cannot
  produce `interrupted` (`nested-runner.ts:729-742`).

## 6. Observability

- Child lifecycle events: `subagent_started`, `subagent_tool_started`,
  `subagent_text_turn`, `subagent_streaming_text`, `subagent_command_message`,
  `subagent_approval_required`, `subagent_completed`, `subagent_interrupted`,
  `subagent_transferred`, `subagent_question`, `subagent_run_budget`
  (`conversation-events.ts:11-43`, payloads `:185-277`).
- Registry progress state: `startedAt`, `lastToolName/At`, bounded
  `turnHistory`, `currentText`, `lastActivityAt`, `lastObservation`, activity
  reasons, model/usage (`subagent-async-registry.ts:80-104`).
- Observer failures: `subagent.task_observer_failed`,
  `subagent.notification_observer_failed` with event type/category/session/error
  (`session-composition.ts:474-493`).
- Evaluator diagnostics: `evaluator.response.received`
  (`shell-auto-approval-evaluator.ts:498-506`).
- Diagnosis: a run whose events arrive in the wrong sink (C3.2), an
  identity that changes across continuations (C3.1), or a `cancelled` run
  reported as `completed` (C3.5) is visible in the event stream and traffic
  `providerHistoryKey`.

## 7. Public boundary under test

- `SubagentAsyncRegistry` (launch, continue, cancel, adopt, dispose, errors) —
  `subagent-async-registry.test.ts`.
- `SubagentBridge` (sink routing, buffering, abort scope, traffic context) —
  `source/lib/subagent-bridge.test.ts`, `.background-sink.test.ts`,
  `.abort-scope.test.ts`.
- `NestedSubagentRunner` (foreground identity, approvals, terminal emission) —
  `nested-runner.test.ts`.
- `SubagentToolPolicy` (capability attenuation) — `tool-policy.test.ts`.
- `ExecutionSubagentRunner` / `MentorRunner` — `execution-runner.test.ts`,
  `mentor-runner.test.ts`.
- `ForegroundSubagentLease` (adopt/detach) — `foreground-subagent-lease.test.ts`.
- Provider session identity — `subagent-provider-session.integration.test.ts`.

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence (file:title) | Status |
| --- | --- | --- |
| Foreground run | `nested-runner.test.ts:419-436` "runs a nested role tool"; `subagent-bridge.background-sink.test.ts:156-186` "keeps synchronous events on the turn sink" | covered |
| Background run | `subagent-async-registry.test.ts:359-369` "returns the exact running launch handle"; `subagent-bridge.background-sink.test.ts:99-108` "delivers events to the background sink" | covered |
| Nested child-of-child run | `subagent-bridge.test.ts:340-370` "a nested subagent run scopes under its parent subagent"; `subagent-async-registry.test.ts:1588-1606` | covered |
| Evaluator traffic | `opencode.provider.test.ts:200+` "createOpencodeSessionInjector gives the auto-approval evaluator its own session ID"; `fetch/composer.test.ts:491+` "createLoggingMiddleware uses evaluator event prefix when traffic context has evaluator flag" | covered |
| Continuation of persistent roles | `subagent-async-registry.test.ts:493-505` "reuses the same run id and session only for a completed continuation"; `mentor-runner.test.ts:360+` "keeps the persistent session when sampling is not configured" | covered |
| Provider session identity | `subagent-provider-session.integration.test.ts:75-153` (foreground distinct, same-scope stable, background continuation stable); `subagent-async-registry.test.ts:1480-1606` | covered |
| Inherited approval settings | `nested-runner.test.ts:449-462` "honors a parent-approved tool inside the nested run"; `tool-policy.test.ts:356-405` (nested shell approval behavior) | covered |
| Attenuated capabilities | `tool-policy.test.ts:90-146` "fails closed when finite filesystem scope disables shell", "empty network scope denies network", and "finite non-wildcard host scope rejects web_fetch"; `:272-405` covers the coarse policy modes | covered |
| Parent abort | `subagent-async-registry.test.ts:538-584`; `subagent-bridge.abort-scope.test.ts:110-130` | covered |
| Turn abort | `subagent-bridge.abort-scope.test.ts:99-130` (foreground cancelled, background survives) | covered |
| Adopted transfer | `subagent-async-registry.test.ts:265-356`; `subagent-bridge.background-sink.test.ts:110-129` (transfer pinned to turn sink before async start); `nested-runner.test.ts:249-285` | covered |
| Explicit stop | `subagent-async-registry.test.ts:519-536` "cancelAllRuns returns before a late successful runner result settles as cancelled"; `nested-runner.test.ts:373-390` | covered |
| Session dispose | `subagent-async-registry.test.ts:337-356`, `:646-664`; `subagent-bridge.test.ts:172` "dispose cancels session work and clears manager-owned state once" | covered |
| Duplicate role/name admission | `subagent-async-registry.test.ts:399-410` (invalid/duplicate active names), `:586-590` (fresh run targeting an active shared session), `:507-517` (active continuation restrictions) | covered |
| Structured error round-trip | `subagent-async-registry.test.ts:399-410`, `:607-615`, `:666-680` (typed registry errors); `subagent-bridge.test.ts:554` "runSubagentAsync preserves a typed duplicate-name rejection without disturbing the active run" | covered |

## 9. Verification commands

Focused (verified 2026-08-14, all green):

```sh
NODE_ENV=test pnpm test \
  source/services/subagents/subagent-async-registry.test.ts \
  source/services/subagents/tool-policy.test.ts \
  source/services/subagents/nested-runner.test.ts \
  source/lib/subagent-bridge.test.ts \
  source/lib/subagent-bridge.background-sink.test.ts \
  source/lib/subagent-bridge.abort-scope.test.ts \
  source/services/subagents/execution-runner.test.ts \
  source/services/subagents/mentor-runner.test.ts \
  source/services/subagents/foreground-subagent-lease.test.ts \
  source/lib/subagent-provider-session.integration.test.ts \
  source/providers/opencode.provider.test.ts \
  source/providers/fetch/composer.test.ts
```

Result: **12 files / 262 tests passed.** This command corrects the Phase 0
baseline Seam 3 command: three of its paths do not exist
(`source/services/subagents/runtime.test.ts`, `subagent-bridge.test.ts`,
`subagent-event-bus.test.ts` — the bridge lives at `source/lib/subagent-bridge.ts`
and there is no `subagent-event-bus` module), so Vitest silently ran only 2 of
5 files. The real runtime tests live in `subagent-async-registry.test.ts`,
`nested-runner.test.ts`, `execution-runner.test.ts`, `mentor-runner.test.ts`.
The evaluator-traffic boundaries cited in the matrix are included as well.
Classification: **test defect in the baseline record, not a product defect.**

Broader gates: `NODE_ENV=test pnpm test`, `pnpm typecheck`, and — for any
bridge/run-loop/registry change — `NODE_ENV=test pnpm test:provider-black-box`.

## 10. Known gaps and classification

All minimum-matrix cells are covered.

The current child-result union has no `unknown` or `ambiguous` terminal state;
as recorded in §5, ambiguous external-effect settlement remains the child
session's tool-ledger responsibility. This is a non-matrix result-union
limitation, not a product defect or uncharacterized matrix cell.
