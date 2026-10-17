# Session boundary simplification

Goal: preserve the single model/tool loop while removing caller knowledge of
Record persistence selection, provider checkpoint/debt update order, approval
presentation-cache restoration, recovery journal snapshots, and post-history
cleanup/logging.

Done checks: source/type inspection must show those obligations deleted; existing
integration, provider-black-box and e2e workflows must pass; temporary probes must
exercise acceptance/persistence failure, continuity publication, stale decisions,
and no-op/successful lifecycle operations. Independent verification is required.

Constraints: public conversation behavior, retry budgets, wire selection, effect
settlement, logging shape and physical job-stop policy stay intact. No additional
execution owner, event bus, or universal coordinator. Invalid history targets must
not reset state or log an undo. Acceptance precedes publication; persistence
acknowledgement is not fsync. Provider context incorporates accepted segments
synchronously. Runtime keeps its decision position; presentation retains caches.

Implementation shape: ConversationRecord owns private initial/decision recovery
baselines and segment persistence selection. ProviderContinuity consumes one
accepted-segment fact. SessionLifecycle absorbs SessionManager's complete history
operations. Approval plans carry decisions rather than presentation snapshots.

Verification and final evidence will be appended here.

Decision admission contract: prevent a saved answer resolving a different retained
wait. Scope: SessionTurnAdapter's root decision-answer boundary, including tool,
ask-user and budget decisions; nested direct runtime handles retain their existing
identity checks. Class: identity/authority admission. Enforcement owner: retained
adapter wait; recovery owner: existing runtime cancellation/recovery paths. Signal:
exact runtime interruption object plus captured generation, direct identity evidence
rather than a timeout/proxy. Legitimate retries of a delivered answer may be stale;
reject only that answer before touching the pending wait, leaving admitted work
unchanged. No thresholds, settings, migration, replay, continuity reset or partial
settlement. Existing caller-visible errors identify no-wait or stale-address cases;
no payload logging. Cancellation retires the callback and runtime interruption.
Rollback: decision input addressing and check together. Independent red proof:
replaying an identical saved answer for ask-user one answered ask-user two in the
same generation (approved=2, secondResolved=true). Temporary verifier harness is
/tmp/session-boundaries-verifier.mts; final evidence retained below.

## Bounded defect retrospective

Independent probing found an escaped defect from the earlier single-turn-owner
refactor (`aa18dcfb`, experiment task `2026-10-17-single-turn-owner`): a saved
internal answer could resolve a later decision in the same generation. No public
user-facing exploit was demonstrated. Generation identifies a turn, so it cannot
identify successive waits within that turn. The adapter assumed its current
callback was the answer's intended destination.

The correction reuses the actual runtime interruption identity and requires it
on the internal decision input. Admission checks identity and generation before
consuming the callback; rejected answers leave the current wait unchanged.
Independent red/green evidence covers identical-answer replay, structurally equal
clones, wrong generations, cancellation, and a successful fresh answer. Existing
provider scenarios covered fresh approvals but did not exercise a saved answer
against a second wait. No timeout, new address registry, permanent unit test, or
static guard was added. This is a local representation fix; physical tool-stop
semantics and public answer construction retain their existing contracts.

The repeatable lesson is to distinguish turn identity from decision identity at
retained-wait boundaries. The explicit type and runtime admission check preserve
that distinction in production; the independent verification report retains its
observable evidence. No new settings, rollout, migration, or cleanup mechanism is
needed. Broader transport and crash guarantees remain outside the focused probe.

Sibling inspection found the only production approval-init creators are the
coordinator factory and adapter auto-approval path; both now attach the current
interruption. Parallel automatic continuations already pass their exact plan
interruption to the executor; runtime tool approval checks identified interruption
identity. Public answer consumption constructs the current internal init. These
checks do not claim to harden every raw continuation handle or nested budget
handle; those existing contracts were preserved.

## Verification results

Final production diff hash (`git diff 844a62c4 -- source | sha256sum`):
`3add3c29bc36a185e35a12e0e13a290474fa0d4d4b2fa7e26c63e2f49f845ec5`.
No permanent tests or static guards were added.

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0, zero errors and 31 existing warnings; Prettier passes.
- `pnpm test`: 28 static checks passed in seven files.
- `pnpm test:integration`: 121 passed, one existing skip, 79.38 seconds.
- `pnpm test:provider-black-box`, isolated final run: 204 passed, one existing
  skip, 77.60 seconds. Exercises the shipped CLI, registry routes, approvals,
  repeated decisions, reasoning, cancellation, completed effects, compaction,
  rollover and provider failure/recovery against fixture servers.
- `pnpm check:no-unit-tests` and `git diff --check`: exit 0.

The first broad integration/provider runs also passed. On a second run sharing
host resources with lint and integration, provider `openrouter-http.early-close`
hit its fixture CLI timeout (`timedOut: true`) and the runner bailed. The complete
isolated rerun passed without production or test changes, including that scenario.
This supports load sensitivity; it does not establish a general absence of timing
flakes. The failed run is retained rather than counted as a pass.

Raw implementing-agent logs are `/tmp/term2-session-boundaries-{lint,static,integration}-final.log`,
`/tmp/term2-session-boundaries-provider-final.log` (timeout),
`/tmp/term2-session-boundaries-provider-serial.log` (complete pass), and
`/tmp/term2-session-boundaries-e2e-final.log`.
Independent fault-injection, lifecycle, request-parity and decision evidence is in
[VERIFICATION.md](VERIFICATION.md).

Remaining uncertainty: fixture providers do not establish all live-service
behavior. Physical background-job stop policy and fsync/crash guarantees were not
expanded. Human comprehension improvement remains unmeasured. Detailed provider
and policy internals remain complex inside their respective modules.

`pnpm test:e2e`: 31 passed in five files, 4.56 seconds. The final source therefore
passed 384 existing checks/tests, with two existing conditional skips, in addition
to the independent focused probes. All final suite commands exited 0.
