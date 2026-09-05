# Inline approval for nested `run_code` calls

## Resume here

This is the implementation handoff requested on 2026-09-05. It replaces the
original proposal and appended corrections with one authoritative sequence.

**Milestone 1 is merged** (`82a756a7`, with `08a71cf7` and `96e65d4e`). Do not
re-implement it.

**Milestone 2b is merged to main as `1f18293f` (2026-09-05).** Branch was
`m2b-scripted-adapter`; worktree `.worktrees/m2b-scripted-adapter`.

**M2 is complete** — both M2a and M2b are merged to main. Do not re-implement
M2b.

**M3 Fork C implemented and merged `114acd70` (2026-09-05).** Work-clock pauses
iff worker `pending ⊆ waitingSet` and idle epoch matches; long-stop never
pauses. M3-safe `7d1f49ca`. **M4 contract drafted and review-folded**
(`.coord/nested-approval/deliver/m4-contract.md`; review
`m4-contract-review.md`). Not implemented. Live:
`.coord/nested-approval/STATE.md`.

### M2b gate evidence (coordinator-verified at `3377be81`, merged as `1f18293f`)

- Typecheck exit 0; focused 2 files / 12 tests exit 0; provider black-box 19
  files / 176 passed / 1 skipped exit 0.
- Fix round `3377be81` (serialized adapter processing, answered-head dedupe,
  disposal drain, real-`sendMessage` acceptance) received CLEAR closure
  reviews from both independent reviewers
  (`deliver/m2b-fix-closure-{astra,grok}.md`).
- Full isolated suite: 606 files / 7,863 passed / 2 failed — one is the known
  pre-existing `releaseDiscovery`; the other
  (`cli.integration.test.ts` "no models match") is environmental: the spawned
  CLI hit a live codex model-list 401 (documented codex model-list degradation
  open item), reproduced on main-equivalent content. The branch changes zero
  `source/` files (3 additions under `scripts/nested-approval/`), so neither
  failure is attributable to the merge.

### M2a final gate evidence (coordinator-verified at `d7c8d8f5`, merged as `317c15bd`)

- Typecheck exit 0; focused 11 files / 197 tests exit 0.
- Full isolated suite: 603 files / 7,829 passed / 1 failed — the single
  failure is the known pre-existing `releaseDiscovery`
  (`openai-agent-client.public-methods.test.ts`, fails on clean main).
- The pre-merge merged-result review returned needs-rework (grok SEV-1:
  orphaned rejection-reason bridge denying the replacement approval head).
  Coordinator-verified against code; closed by single-owner slice `fix4-bridge`
  (`f5e98b99`, real red-then-green on the production key path), re-verified by
  the SEV-1 filer (`fix4-closure-grok.md`: SEV-1 closed, no new regression).
- Merge dry-run against moved main clean; accidental `.coord/` scratch removed
  from the branch before merge.

Full verification chain: `.coord/nested-approval/deliver/fix4-bridge.md`,
`fix3-merged-review-{astra,grok}.md`, `fix4-closure-grok.md`. Coordination
state: `.coord/nested-approval/HANDOFF.md`. M2b dispatch brief:
`.coord/nested-approval/brief-m2b.md`.

How M2a got here (for review-history context): two broad fix rounds shipped
shared-boundary regressions and fixture-instead-of-production test evidence,
tripping the convergence stop rule below. Round 3 changed method to three
disjoint single-concern slices — UI `79f2d62c`, GRANT `0379d353`, BIND
`baef6ec2` — each with a boundary test on production owners and a real
red-then-green; a fourth slice `fix4-bridge` `f5e98b99` closed the post-merge
review's SEV-1. See `docs/plans/run-code-nested-approval-preflight.md` for
experiment evidence and limits (do not hide tools first; the unresolved
deadline design is not solved). Use `TMPDIR=/tmp` when running tests here:
`os.tmpdir()` inherits the app's allowed sandbox temp root, so "outside"
fixtures land inside the allowlist and containment assertions silently pass.

Recorded, deliberately not fixed in M2a (all pre-existing, none a round-3
regression): native freeform `apply_patch` bypassing the descriptor/grant
extractor via its `JSON.parse` guard; `apply_patch.needsApproval` not consulting
`allowsEdit` on the outside path; `authorityRoot` vs `getActiveWorkspaceRoot()`
divergence for relative nested paths; the LLM auto-approve seam in
`conversation-result-builder.ts:364-370` still granting every target.

### First actions

1. Read this plan and the preflight report. Use repo skills `architecture`,
   `testing`, and `provider-testing` for registry/work-loop changes;
   `terminal-input-ownership` and `react-ink-testing` for UI work;
   `guard-design` and its referenced ledger before changing deadlines. Read
   `docs/plans/sandboxed-code-host.md` before modifying either script tool.
   Read `docs/profiles/README.md` before changing mode/profile tool
   construction.
2. Recheck repository state. Main moves under you — other sessions merge to it
   during this work. Main carries a pre-existing edit in
   `source/components/input/SettingsMenuSession.test.tsx` owned by another
   session; preserve it.
3. Use an implementation worktree under `.worktrees/` and install with pnpm,
    following AGENTS.md. Both plan documents are untracked in main; fresh
    worktrees will not contain them automatically. Read them from the primary
    checkout.
4. Do not implement M3 until the guard contract exists and is reviewed.
    Current work is evidence collection only (briefs under
    `.coord/nested-approval/briefs/`). Keep direct fallbacks until Milestone 4.
5. Update this section and milestone evidence at handoff: actual commits/checks,
    unresolved gates, and exact deliverable locations.
### Existing experiment

- Worktree: `/home/qduc/term2/.worktrees/nested-approval-preflight`.
- Branch: `nested-approval-preflight`, based on `b1b2e3fd`.
- Uncommitted test:
  `source/components/layout/BottomArea.nested-approval-preflight.test.tsx`.
- SHA-256 at handoff:
  `477c6680024bc7558414e07212936c50d9a3ac4fb27729b8c3744f166d71b605`.
- Executed evidence: 4 focused files / 56 tests passed; typecheck passed;
  `test:changed` selected the experimental file and passed its 5 tests.
  These results apply to that checkout, not future implementation changes.

The experiment is not a partly implemented production branch. Its candidate
waiter simulates policy/grants/lifecycle. Adapt useful assertions to real owners;
do not promote that fixture into production. Preserve its concurrency
counterexample.

## Product contract and settled decisions

When `run_code` exists, the final direct surface contains `run_code` and tools
structurally prohibited inside scripts. Other resolved tools are available
through `tools.<name>(params)`, including file/search/edit/web tools. Profiles
without `run_code` retain their direct surface.

Safe nested calls execute immediately. Approval-required calls present the
existing approval UI with the exact prepared arguments; consent continues the
same script. Denial is catchable and earlier effects are never replayed.

- Outer script approval is not blanket nested authority. One-time consent
  authorizes that call; explicit existing session/folder grants may authorize
  later calls, each evaluated independently.
- Unknown policy, invalid parameters, interceptor denial, and unavailable
  interaction execute nothing. Policy exceptions must not become approvable
  just because a nested UI is available.
- Deny/reason rejects the selected nested call. Escape/explicit stop cancels
  the outer run; disposal invalidates its waiters. Late or duplicate answers
  cannot grant authority or dispatch a settled call.
- Preserve wrapped execution, call attribution, hooks, and output handling.
  Arguments shown must be those executed, including path/context meaning.
- Keep approval host-side. Preserve VM-realm-owned bindings and JSON crossings;
  the VM is not an OS security boundary.
- Shell/bash, agent/workflow control, mentor, user interaction, and rollover
  remain prohibited inside scripts. For the initial nested-approval rollout,
  also prohibit nested worktree transitions and retain their direct tools.
- No replay, checkpoint format, escrow tool, blanket trusted-script mode, or
  separate script-local grant policy is part of this implementation.
- Preserve separate script completion and diagnostic-output channels.

## What the preflight proved

The host already awaits capability invocation. Real `BottomArea`/
`ApprovalPrompt` plus a real `SandboxedCodeHostImpl` worker handled one-time
approval, returned a session-folder answer, caught denial without replay, and
routed Escape to cancellation. A test-only liveness check ignored late approval.

This does **not** prove production session routing, grant application,
rejection-reason input, prompt arbitration, or safe deadline exclusion.
The fixture's cancellation check is not installed in production.

`deriveInputOwner()` requires effective non-processing input state for approval.
`app.tsx` already projects this for sandbox/background prompts. Actual execution
must stay active while presentation changes; effective UI state must not admit
another outer turn or manufacture a provider continuation.

The experiment also proves worker computation and a default-lane call can
proceed while a serial-lane approval waits. Host permit pools are independent.
Prompt serialization, default concurrency one, and full host-call serialization
do not establish suspension of arbitrary script computation.

## Milestone 1 — isolate approval-policy ownership

Goal: coexisting tool graphs cannot overwrite one another's captured workspace
or grant policies. Preserve existing visibility and approval outcomes.

Trace the same registry instance through graph construction and consumers:

| Seam | Starting symbols and source paths |
| --- | --- |
| Policy storage | `ToolApprovalPolicyRegistry`, `services/approval/tool-approval-policy-registry.ts` |
| Registration and wrapping | `buildAgentTools`, `lib/agent-factory.ts`; `wrapNeedsApproval`, `lib/tool-invoke.ts` |
| Composition/configuration | `agent.ts`, `lib/agent-configuration.ts`, `services/session/session-composition.ts` |
| Nested invocation | `createRunCodeToolDefinition`, `tools/system/run-code/run-code.ts` |
| Batch approval | `ToolApprovalBatchCoordinator`, `services/approval/tool-approval-batch-coordinator.ts` |
| Result construction | `services/conversation/conversation-result-builder.ts` |

Paths in this table are relative to `source/`. Production consumers must receive
the actual graph registry rather than silently falling back to the singleton.
Trace rebuild/disposal and parent/child construction; ownership follows the
definitions being governed. Do not replace the singleton with a global
session-ID lookup.

Audit native `apply_patch` replacement: consulted policy must match the final
definition bound for nested execution. Registration before a policy-changing
substitution is insufficient.

Acceptance: construct two real tool graphs with different workspace/grant
state, then interleave decisions after both exist. Cover construction order,
rebuild, direct batch/result consumers, and native/custom patch where applicable.
Each graph uses its own policy; direct outcomes and nested deny-on-prompt stay
unchanged. Run focused tests, typecheck, related/changed tests, and provider
black-box during development.

## Milestone 2 — own nested decisions and input routing

Use a session-owned request/decision owner in `services/approval/`, injected
into the graph. It owns pending identities, one displayed request, cancellation,
and once-only decision consumption. Define a small host-side request,
snapshot/subscription, decision, and close interface at that owner.

Requests bind session/tool-graph identity, outer run, nested call ID, immutable
prepared arguments, authority-relevant context, and abort signal. Preserve the
existing answer vocabulary and rejection reason; a binary port loses grants.
Choose one domain owner to apply grants exactly once.

`ApprovalDecisionExecutor.resolve()` currently applies grants but also calls
continuation methods, records events, releases ownership, and emits hooks.
Share grant semantics at a deliberate seam. Do not use a dummy continuation or
copy path policy into `App`. Preserve direct behavior with owner tests.

The intended flow:

1. Prepared call evaluates valid policy and requests nested consent.
2. The session publishes the descriptor into existing prompt arbitration.
3. `App` projects matching state to input ownership and `BottomArea`.
4. Approve, Deny/reason, or Escape routes to the matching nested owner.
5. Invocation revalidates, commits authority, and dispatches once.
6. Its result resolves the existing worker promise.

Do not call `continueAfterApproval`; there is no corresponding provider
interruption. Preserve waiting requests while sandbox/background/root or
higher-priority UI owns the screen. One nested queue is not proof of exclusive
ownership across sources.

After waiting, recheck liveness, graph identity, workspace/path meaning,
interceptors, and policy. Unknown/error denies; auto-approval permits; valid
exact-call consent can satisfy a still-`prompt` decision. Requiring auto-approval
after one-time consent would prompt forever. Changed targets invalidate consent.
Recheck immediately before granting/dispatching; asynchronous revalidation must
not reopen the cancel/approve race. An interceptor denial should not prompt.

`ToolApprovalPolicyRegistry.evaluate()` currently maps exceptions to `prompt`.
Distinguish failure from a valid consent request before enabling nested approval,
and characterize the effect on direct consumers.

Acceptance includes real session/Ink tests for approve once, grant followed by
auto-approval, Deny/reason, Escape, stop, steering, two pending calls, competing
prompts, graph change, disposal, duplicate/late answers, and both race orders.
Assert actual grants/effect counts, not just answer strings. Programmatic steering
stays queued for the next model request boundary; reason text must not become
an ordinary turn.

## Milestone 2 scope change — a scripted responder is an M2 acceptance deliverable

**Status: reviewed and adopted with changes 2026-09-05.** Adversarial review by
`gpt-6-astra`: `.coord/nested-approval/deliver/astra-plan-review.md`. Verdict
ADOPT WITH CHANGES. The four amendments below are the review's corrections and
supersede the original proposal wherever they differ.

Milestone 2 above lists two deliverables: the session-owned decision owner and
input routing into the existing approval UI. This section adds a third and
raises the bar for acceptance evidence.

### Why

The exp-shell experiment (`.coord/orch/exp-shell/RESULTS.md`) ran all 14 cells
under `--auto-approve`. `shell_nested_denied` was 0 in every cell while
`shell_nested` reached 45 in one run. Those cells cannot observe the denial path
at all, so they would report the design as working whether or not it is.

Scope that claim precisely: it is the auto-approved benchmark cells that are
blind, not all existing instrumentation. A nested denial is already observable
without `--auto-approve` and without M2 — `source/tools/system/run-code/run-code.test.ts:692-712`
does exactly that today. What is missing is an automated stimulus through the
*new* owner, not a new observation capability.

**The ordering claim is therefore weaker than first written.** The real
dependency is `owner interface → adapter → acceptance evidence → closing the
gate`, not simultaneous authorship. The responder is an M2 *acceptance*
deliverable: M2 is not complete until the evidence exists. It is not a technical
precondition for writing the owner.

### What M2 now delivers

1. The session-owned nested approval request/decision owner (unchanged, above).
2. Input routing and prompt arbitration (unchanged, above).
3. **New:** a host-supplied scripted decision adapter behind the nested owner's
   decision interface, plus the deterministic approve/deny evidence it produces.

A defensible split, if M2 is landed in stages: **M2a** = owner + revalidation and
grant semantics + interactive routing, direct fallbacks retained. **M2b** = the
scripted adapter and its evidence run. M2 is accepted only when both pass.

### Amendment 1 — share a decision interface, not the terminal-result loop

The original text required nested approvals to reach "the same loop direct calls
already reach." That contradicts M2's own prohibition on `continueAfterApproval`.

`source/non-interactive.ts:205-216` awaits `session.sendMessage()` and only then
inspects the returned `approval_required` terminal. During a nested approval the
script is still live and `sendMessage()` has not returned, so that loop
structurally cannot answer. Manufacturing a terminal instead lands in
`source/services/conversation/conversation-adapter.ts:993-996` (no ordinary
pending approval → null) or `:1088-1096` (`continueAfterApproval`), neither of
which resolves the live nested waiter.

Instead: a host-side adapter subscribed to or injected into the session-owned
nested request owner, attached before the turn starts, returning a decision to
that exact pending request while the script remains active. Direct approval
continuation is unchanged. Require a real-session test showing the same worker
promise resolves and no provider approval continuation is fabricated.

### Amendment 2 — the adapter is test/benchmark-only, and that is enforced

Resolving the third open question below: **test-only.** A comment or an
environment flag does not enforce it.

- The adapter is supplied by a dedicated test/benchmark entry point. Ordinary
  headless construction must not be able to select it, and an integration test
  must prove that.
- It answers only typed ordinary nested tool requests with deterministic
  expected-call answers. Unmatched requests, invalid identity, stale answers,
  responder failure, and disposal all deny. `ApprovalDescriptor`
  (`source/contracts/conversation.ts:112-124`) also carries budget, check-in and
  post-execute pauses; those are not nested tool consent and get no authority.
- The adapter supplies answers, not a second grant policy. M2's existing
  revalidation and once-only grant ownership remains the sole authority
  boundary, including the known `prompt`-on-exception correction at
  `tool-approval-policy-registry.ts:35-47`.
- `NonInteractiveApprovalPolicy` keeps its existing responsibility for direct
  terminal approvals. Do not add a third mode to it.

This also resolves the fail-closed question: an ordinary headless session with
**no registered decision owner** denies promptly (M4); a deliberately
constructed test session with a host-owned adapter answers only its own exact
pending requests. State that distinction in M4 rather than leaving it open.

If a supported product headless approval surface is ever wanted, it needs its
own authority contract and review — it is not implied by this fixture.

### Amendment 3 — a denial counter alone can pass on unchanged code

A first observed nested denial does not prove a request reached the new owner. A
`prompt` result already maps to `denied-by-approval` and rejects locally today,
and the JSONL schema carries no responder-decision provenance.

Acceptance therefore requires a deterministic probe through the real owner with
two explicit decisions — approve once, deny with reason — asserting that:

- the responder saw the expected nested request identity;
- the approved effect occurred exactly once;
- the denied effect occurred zero times and the denial was catchable in-script;
- earlier effects were not replayed;
- no provider continuation was fabricated;
- exactly one terminal outcome is emitted after settlement. A pending approval is
  not a denial — do not keep the old pre-wait `record(..., 'approval_required', ...)`
  alongside a later success.

Keep the JSONL format verbatim (on main as `08a71cf7`, gated on
`TERM2_NESTED_CALL_LOG`) so post-M2 runs stay comparable to the 14 pre-M2 cells —
but treat it as a corroborating outcome metric, not proof of the decision path.
The logger deliberately suppresses write failures and skips absent session IDs
(`run-code.ts:240-260`), so zero responder invocations, an absent or unreadable
log, or ambiguous session attribution is an **invalid run**, not a passing zero.
Also note the exp-shell runner still hard-codes `--auto-approve`
(`.coord/orch/exp-shell/run.sh:124-136`); the acceptance cell must specify its
own invocation and effective prompt policy.

### Amendment 4 — M2 does not reopen script-only shell

The original text said M2 "removes the grounds" for closing the script-only
configuration. Overstated. Shell and bash remain structurally prohibited in this
plan and in the live `run_code` namespace (`run-code.ts:60-69,279-280`);
resolving generic nested prompts does not change that, and the coordinator-owned
shell approval state the prohibition rests on is not integrated. The exp-shell
verdict also rested on independent adaptive-task performance and call-cap
findings (`RESULTS.md:19-28`), which a denial fix does not erase.

Correct framing: M2 removes **one obstacle** that a separately designed,
separately reviewed shell-enabled experiment would face. It does not authorize
shell and does not settle arm C. M2 acceptance uses a named approval-capable
**non-shell** tool.

### Still to specify before implementation

(a) nested-owner-to-adapter wiring, distinct from provider continuation;
(b) test-only selection and proof of production non-reachability;
(c) request identity, deterministic answers/reasons, unmatched and error
behavior; (d) how the adapter uses rather than duplicates the existing
authority/grant owner; (e) the concrete prompt-policy harness invocation with
mandatory responder-delivery and effect assertions; (f) terminal logging
semantics, evidence-completeness rules, and the non-shell scope of the probe.

These are small contract decisions, not a general-purpose responder framework.

## M2 scope decision — considered splitting editor-grant work, then reversed (2026-09-05)

**Decided after consulting three independent advisors** (`gpt-6-astra`, `grok-4.6`,
and a Claude advisor); full advice in `.coord/nested-approval/deliver/scope-advice-*.md`.

All three rejected the framing the question was first asked in. Whether a defect
predates this work is **not** the axis. The axis is: does an M2 acceptance claim assert
this behavior, did this work create a new path through it, and does deferring leave a
fail-open?

**Outcome: nothing was split. Everything below stays in M2a and is implemented.** The
section is kept because it records why each item belongs to this milestone, and because
the reversal is a worked example of advice resting on an unverified code claim.

### Stays in M2a

- **Result-builder policy fail-closed** — `error`/`interceptor_denied` must not reach
  advisory approval or install grants. This was the incomplete half of the registry
  correction M2a itself was assigned, not an unrelated bug. Fixed in `5230bfa0`; keep.
- **Continuation settlement of the new refusal path** — bounded to settling *this*
  refusal truthfully on initial and continuation turns. Do **not** rebuild continuation
  recovery generally; that weakness predates this work and stays out.
- **Physical target binding across the approval wait** — this is an M2 requirement, not
  an inherited defect: `:79` ("path/context meaning") and `:174-177` ("Changed targets
  invalidate consent"). A lexical `path.resolve` compares a string to itself and does not
  satisfy it.

  **Ceiling, so this does not become another pass:** capture physical root and physical
  target (nearest existing ancestor for creates) with the same semantics execution uses;
  re-resolve after the wait; any change denies with zero grants and zero effects;
  dispatch the bound target. **Do not** attempt to close the check-to-`open()` TOCTOU —
  that race exists on the direct path and is not M2. If physical identity cannot be
  established, **deny**. Fail-closed is an M2-compatible resolution; an unbounded
  filesystem project is not. The regression test must actually retarget a symlink during
  the wait — a boolean `revalidateAuthority` callback is not that test.

### Reversed 2026-09-05 — the split premise was factually wrong

The split rested on grok's claim that the editor-grant repair was one policy change
across three tools: "`search_replace.ts:314-316` and `apply-patch.ts:273-280` do the
same [throw before `allowsEdit`]." **That is false.** Verified against `addd3423`:

- `search-replace.ts:330` and `apply-patch.ts:294,312` already consulted
  `sessionAccess.allowsEdit`, and already resolved with `allowOutsideWorkspace: true`.
  Their session grants worked before this milestone. Neither file was modified by any
  M2a commit.
- Only `create_file` was broken, and not for a missing `allowsEdit` — line 141 called it
  even at `addd3423`. The defect was that `resolveWorkspacePath(filePath, cwd)` **threw**
  before reaching it, and the catch returned `true`.

So this was an 18-line one-tool fix, not a three-tool policy change, and there is no
partial-consistency hazard: all three tools now behave the same way. The reason for
splitting evaporates with the premise.

**Both items are therefore back in M2a and are implemented in `3a6da9d0`:**

- `create_file` resolves outside paths without throwing before consulting
  `sessionAccess.allowsEdit`. Physical containment and protected-hook checks remain on
  the ungranted path. Tested against the **production** definition and executor.
- `apply_patch` authority targets come from the real upstream patch parser, covering
  Move destinations as well as sources; descriptors and edit-session grants consume the
  same extractor. The deleted `{path, operations}` schema was not revived.

**The M4 prerequisite note added earlier is withdrawn** — there is no deferred slice.

**Method note worth keeping:** three advisors agreed on the framing and still produced a
recommendation resting on an unverified code claim. Advice about code needs its load-
bearing claims checked before it is acted on, exactly like a worker's report. Checking
cost one `git show`; acting on it would have reverted correct, tested work and left a
real one-tool defect open.

### Convergence stop rule

Severity falling (1 critical → 0, 8 findings → 6) is **not** a convergence metric —
review scope and severities differ between passes. The non-converging axis is that two
consecutive rounds shipped tests substituting a synthetic policy for the production one.

Judge the next pass on: zero new regressions in changed control flow; every cited test
exercising the production definition; and remaining findings being coverage-only. If a
round again produces fresh shared-boundary regressions or fixture-instead-of-production
evidence, stop broad patching and change the execution method — not the acceptance
requirement.

## Milestone 3 — close concurrency and deadline containment

Start from prompt-only serialization with nested worktree transitions prohibited,
preserving safe fan-out where possible. Check external context changes and
multiple outer calls. Add broader restrictions only with a concrete
counterexample and explicit tradeoff. Full serialization is not worker suspension.

The target excludes human approval wait from execution time while preserving
finite containment of actual work. Unconditionally pausing the host timer when
approval opens fails this requirement: siblings/computation may continue.
The current protocol reports calls/results, not authoritative worker idleness.
Do not infer asynchronous computation coverage from the initial synchronous VM
timeout.

Complete the guard contract against `docs/plans/guard-ledger.md` and its owner
plans: configuration precedence/effective limits, observation boundary, legitimate
human waits, active siblings/computation, queued calls, shared-host callers,
cancellation, partial effects, observability, and rollback. Choose and prove a
concrete suspension/accounting boundary. Do not change defaults or persisted
settings without evidence.

Do not silently retain wall-clock expiry during human waits as the final design.
That is a smaller temporary limitation, but does not meet the target. If correct
accounting requires a materially larger worker architecture, finish unaffected
milestones and present concrete alternatives/evidence for the user's product
decision. This open gate does not block Milestone 1.

Acceptance: human-only waiting survives; active work stays bounded; boundary
values and remaining time are correct; cancellation clears waiters; late answers
cannot execute after timeout. Host-side effects already dispatched may be
ambiguous; worker termination does not undo them. Preserve truthful settlement
and no automatic replay.

## Milestone 4 — integrate and hide scriptable direct tools

Keep direct fallbacks through Milestones 1–3. After their gates pass, bind the
complete wrapped registry before filtering the direct surface. Visibility depends
on structural prohibition, not `canRequireApproval`. `run_code` stays direct and
cannot recursively call itself through its namespace.

Hide editors only after approval-required nested edits work. Test removal of
native direct freeform `apply_patch` and availability of nested JSON editing.
Profiles without `run_code` retain their surface. Sessions without an interactive
owner fail closed promptly; no hanging waiter or instruction to call a hidden tool.

Update namespace/header, discovery, direct names, system guidance, refusal text,
and prompt/cache expectations together. Test safe reads/search/web/edits,
approval-required reads/edits, exact arguments/effects, no replay, prohibited
namespace, profile variants, headless behavior, native/custom patch, and provider
request/result-chain identity.

Use Ink/session integration for real keyboard ownership. Provider black-box may
need a nested-decision adapter; an injected answer proves the result chain, not
keyboard interaction. Record both forms of evidence separately.

## Verification and deliverables

Follow repo policy: focused red/green through real owners; typecheck for TS;
related/changed selection plus intentional behavioral scopes; provider black-box
during provider/bridge/run-loop/registry/non-interactive work; isolated full suite
at coherent architectural handoff. Empty test selection is not green.
Distinguish baseline/environment failures. The fixed no-isolate lane is not the
full-suite authority.

Deliver production changes and owner tests in the implementation worktree,
updated milestone evidence here, and remaining limitations. Reuse metadata
logging for identity, decision, wait duration, and settlement without
arguments/secrets; a new telemetry pipeline is not required.

Follow current user/repository authority for commits/integration. This document
does not authorize overwriting another agent's edits or publishing externally.

## Rationale and review provenance

Original discussion: Codex task `01a06cf1-1934-7f50-9d1f-69fd0ff5bf22`.
The user challenged the claim that inline consent needs complex VM resume
machinery. The host-await seam and preflight support that challenge; session
authority and execution containment still require implementation.

Sol favored approval escrow; agy also explored it. Claude explored
grant-and-rerun; Grok favored inline waiting. Replay was rejected because earlier
effects could repeat. Escrow adds a model round trip and changes the requested
UX. Blanket trust broadens authority. Keeping approval-capable tools direct
preserves the bypass of the desired code-first surface. Inline waiting remains
the product direction.

Later reviews called for the UI preflight, richer grant decisions, session-local
policies, precise cancellation, and evidence on concurrency. Grok's final
`needs rework` report was recovered from `review-grok-codefirst`, session
`01a06d26-6eba-7393-8e90-b4fd3ff99451`. It attributed findings to six child
passes; their individual artifacts/disposition were not verified. This
consolidated plan has not received another independent review.
