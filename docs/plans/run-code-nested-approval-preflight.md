# Nested approval preflight

## Resume here

Read with `run-code-nested-approval.md`. This is evidence from a test-only
experiment on `b1b2e3fd`, not a shipped nested-approval implementation.

The existing approval presentation can serve a live worker without a provider
continuation. Five executable checks establish that narrow claim. They do not
establish session routing, grant application, or safe deadline exclusion.

Experiment checkout: `/home/qduc/term2/.worktrees/nested-approval-preflight`.
Test: `source/components/layout/BottomArea.nested-approval-preflight.test.tsx`.
The test is uncommitted and has not been merged into main. Main's pre-existing
changes to `run-code.ts` and `SettingsMenuSession.test.tsx` were not copied or
modified. No production code was changed.

## Executable evidence

The tests compose the real `BottomArea`, `ApprovalPrompt`, input provider, and
`SandboxedCodeHostImpl` with a real worker. A test-only capability handler waits
for the UI callback and returns the namespace result envelope. It models a
candidate adapter; it does not invoke the actual `run_code` approval registry.

| Check | Observation | Limit |
| --- | --- | --- |
| Processing to approval input state | With `isProcessing: true`, no approval menu; with the effective non-processing presentation state, the menu handles Enter and the same worker returns its result | Does not mount `App` or its keyboard-shortcut hook |
| Session-folder choice | The menu delivers `allow-folder-session` through the awaiting call | Does not apply a grant or prove a subsequent call auto-approves |
| Deny | The script catches rejection and continues; the earlier recorded effect occurs once | Routes Deny directly to the waiter; rejection-reason entry still needs session integration |
| Escape and late answer | Escape calls cancellation rather than Deny; parent abort settles the host; a later approval produces no recorded effect | The liveness check is in the experimental adapter, not production |
| Activity while waiting | The script computes a value and executes a default-lane sibling while a serial-lane approval remains pending, even with default concurrency one | Demonstrates overlap, not a timeout-pause implementation |

The initial test run failed because the fixture inspected `payload.name`
instead of the namespace protocol's `payload.member`. Correcting the fixture
produced the passing results. This was not a production red/green bug fix.
Typecheck also caught an inferred result union containing optional `undefined`
properties; an explicit `CapabilityOutcome` return type corrected the fixture.

## Selected ownership direction

Use a session-owned nested approval request/decision owner in
`services/approval/`, injected into the tool graph. It owns pending-call identity,
one displayed request, cancellation, and decision consumption. Requests bind the
session/tool graph, outer run, nested call, and prepared arguments. Keep this
host-side; no approval callback or host object crosses into the VM.

The event path should be:

1. A prepared nested call requests approval through that owner.
2. The session exposes the active descriptor to `App`.
3. `App` projects effective approval input state to both `deriveInputOwner`
   and `BottomArea`, as its sandbox/background adapters already do.
4. Approve, Deny/reason, or Escape returns to the matching nested request owner.
5. That owner and the invocation boundary revalidate liveness, authority, and
   context before committing a grant and dispatching the exact call.
6. The handler returns its result to the existing worker promise.

Do not transition the outer run through `continueAfterApproval`: this path has
not produced a provider approval interruption. The actual execution stays
active while only the input projection changes. Do not use effective UI
`isProcessing: false` as permission to admit another outer turn.

`App` currently prioritizes sandbox prompts over background approvals over root
approvals. The nested owner must participate in that arbitration and preserve
pending requests when another source is displayed. Its own queue does not by
itself establish exclusive ownership across all four sources.

### Grant and input decisions

- Preserve the existing answer vocabulary. Map an undefined one-time UI answer
  to the domain's one-time consent at the adapter boundary, not a broad grant.
- Share grant interpretation/application with the approval domain rather than
  copy path policy into `App` or the sandbox host. Before extracting it, account
  for `ApprovalDecisionExecutor.resolve()` calling `state.approve/reject`,
  recording tool events, releasing ownership, and emitting hooks. A dummy
  continuation would hide these effects rather than resolve them.
- Deny enters rejection-reason input and ultimately rejects only the nested
  call. Escape follows ordinary root approval semantics: cancel the outer run.
  The test proves the prompt offers separate callbacks, not that production
  routes every reason-input transition correctly.
- Programmatic steering stays queued for the next model request boundary;
  `ApplicationRunLoop.steer()` does not resolve nested waiters. Keyboard text
  in reason-entry mode must reach the nested rejection path, not ordinary
  turn submission. This needs an `App`/session integration check.

## Concurrency and deadline decision

Prompt-only serialization is sufficient for one visible menu, but insufficient
for execution containment. Prohibiting nested worktree transitions removes one
context race; it does not stop sibling execution or script computation.
Serializing all host calls also does not suspend JavaScript in the worker.

Do not implement unconditional `pauseTimer()` when the first approval opens.
The fifth test supplies a concrete counterexample: active work continues while
that promise waits. The current worker protocol reports calls and results, not
an authoritative idle/quiescent state. The synchronous VM timeout is not proof
that all computation after asynchronous continuations is covered.

The next host design must either establish a real suspension/accounting boundary
for the worker and its admitted calls, or explicitly retain wall-clock timeout
behavior during human waits as a temporary product limitation. The latter is
smaller, but does not meet the current plan's human-wait exclusion requirement.
This preflight does not silently choose that limitation or add a new budget.
Complete the guard contract before changing timeout behavior.

## Remaining acceptance gates

The worker/presentation feasibility question is answered. Full interactive
rollout remains gated on:

- session-local registry wiring, including native patch policy parity;
- actual grant application, one-time vs session consent, and context revalidation;
- whole-session input routing for reason entry, stop, steering, competing prompt
  sources, two outer runs, and disposal;
- a concrete deadline/suspension contract that accounts for active siblings;
- provider-visible partition and result-chain checks after integration.

Keep direct editor fallbacks until these pass. The smallest independent next
implementation is session-local policy-registry wiring; it does not depend on
the unresolved human-wait clock design.

## Validation

Executed in the experiment checkout:

- `pnpm test source/components/layout/BottomArea.nested-approval-preflight.test.tsx source/lib/input-owner.test.ts source/components/layout/BottomArea.test.tsx source/services/sandboxed-code-host/sandboxed-code-host.test.ts`
  — 4 files, 56 tests passed.
- `pnpm typecheck` — passed after the fixture type correction.
- `pnpm test:changed` — selected the new file; 5 tests passed.
- Prettier formatted the new test.

No full-suite or provider black-box rollout claim is made: the change is an
experimental test and this report, with no production/provider implementation.
