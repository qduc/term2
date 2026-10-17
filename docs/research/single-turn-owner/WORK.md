# One execution owner

Goal: one production model/tool loop owns advancement, approval/budget waits,
post-execution waiting, recovery and termination. Remove TurnWorkflow's second
execution task and initial/continuation drivers. Preserve observable behavior.

Acceptance:
- Source inspection: session adapter has no executable turn task, attempt/recovery
  loop, model dispatch, or continuation dispatch; it supplies bounded preparation,
  projection, policy and interaction operations to the runtime.
- Runtime owns the only model/tool loop. Root and nested paths retain supported
  behavior; external approval APIs answer owned waits and observe progress.
- Repeated approvals, ask_user answer/cancel, pending steer edit/retract/release,
  cancellation and successor turn pass through real built CLI/HTTP/PTY checks.
- Provider recovery, partial history, compaction, nested/parallel/background tools,
  queue persistence/gateway contracts remain covered by full existing suites.
- Typecheck, lint, static guards and no-unit-tests gate pass; independent verifier
  accepts final source and build; retain evidence and update affected docs/ledger.

Constraints: isolated worktree codex/single-turn-owner; no timeout, retry-budget,
approval or stop-proof policy redesign; no release; no permanent unit tests.
Baseline: f2a9ec8a. Independent verifier: /root/single_owner_verify.

Design: runtime directly awaits bounded session interaction/recovery operations.
Session preparation/projection retains necessary accounting and journal facts.
Rejected: merely move or rename TurnWorkflow's nested drivers; that leaves the
same duplicate ownership. Also reject coupling shared runtime to root UI/store;
root behavior arrives through a narrow session boundary.

Risks: partial-output settlement before recovery, correct call identities and
provider anchors, approval ordering, post-execute gates while consumer is live,
observer abandonment, cancellation while preparing or awaiting a decision.

Implementation:
- `ApplicationRunLoop.#runTurn` now owns preparation, model/tool repetition,
  decision waits, authorized session recovery and completion. One `try/catch`
  returns policy-authorized recovery to that same loop.
- `SessionTurnAdapter` replaces `TurnWorkflow`. It supplies bounded callbacks
  for history preparation, event projection, decisions and recovery policy.
  Its public answer API resolves a promise; it never calls startStream or
  continueRunStream. LiveRun is its observation mailbox, not another driver.
- The runtime retains its actual tool operation through manual approvals,
  question answers and budget waits. Post-execute tools retain their existing
  promise/registry path while the same observer stays live.
- Removed unused root resume-handle and aborted-initial options, plus the
  unproduced resume_stream recovery variant. No production policy emitted that
  variant and no production start caller supplied those options. Accepting a
  live legacy handle in the new root API could create a second owner. Actual
  nested/native startStream and continueRunStream callers remain supported.
- Coordinator admission/status, hooks, provider continuity, journal/effect
  settlement, queue persistence and physical stop proof keep their owners.

Review triage:
- Route: abandoning an observer must close the delegated iterator and reject
  pending decisions before awaiting completion. Use existing abortLiveRun;
  no new scheduler or cancellation registry.
- Route: terminated continuation recovery rethrows the original error, retaining
  the public error/hook surface. No new failure state.
- Route: preserve conditional accumulator reset and stop-after-resolution across
  batched approvals. Reuse existing accounting/decision facts.
- Narrow: remove unused root live-handle adoption instead of maintaining a
  second resumable execution route. Nested native continuation remains intact.
- Accept: bounded batch decision collection remains in the adapter; it neither
  executes tools nor starts requests. Event-draining loops project results.

Validation details and final independent verdict are recorded below after the
final checks. Earlier full provider matrix: 204 passed, 1 skipped. Earlier full
integration: 121 passed, 1 skipped. E2E: 31 passed. Codex network: 16 passed.

Final ownership/cancellation boundary:
- The runtime owns a whole-turn cancellation controller. Its signal spans
  preparation, request views, decisions and retry backoff; abortSegment only
  replaces a stream view. Stop cannot dispatch a later attempt after a delay.
- The independent verifier accepts the final source in [VERIFICATION.md](VERIFICATION.md).
  Its four real source probes cover streaming and approval abandonment, actual
  post-execution gating, and Stop during retry backoff with successor admission.
  A deliberate cleanup mutation reproduced both abandonment failures.
- [Retrospective](retrospective.md) records the lifetime defect class and sibling audit.

Final rebuilt provider matrix: **204 passed, 1 skipped** (24 files). Final rebuilt
e2e: **31 passed**. Static guards: **28 passed**. Typecheck, build, lint and
no-unit-tests gate pass; lint retains 31 existing warnings. Final source hashes
match the independent manifest. Integration final rerun is recorded below.

Two intermediate reruns failed: provider-error CLI timeout during concurrent
checks, and a first-frame timeout assertion in the fake Codex e2e. A later e2e
started concurrently with distribution rebuilding and failed before initial UI
idle. Those outputs are retained rather than suppressed. Isolated provider CLI
6/6, final built e2e31/31, and the complete final provider204/204 pass without
changing any execution or test deadlines. Their exact causes were not fully
isolated; build/read concurrency and transient timing remain diagnostic limits.

Limits: fixture providers rather than paid live calls; existing provider and
integration skips remain; no exhaustive scheduling proof or human comprehension
measurement. The postexecute probe uses a custom wrapped tool, real registry and
filesystem effects rather than an OS denied-read sandbox journey. No release.
The architecture skill edits only correct references to the changed runtime;
no new agent skill or delegation capability was introduced.
