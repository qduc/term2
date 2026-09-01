# Term2 Guard Ledger and Remediation Plan

Status: **Discovery and candidate characterization complete. The
`maxParallelToolCalls` defect is repaired and merged (`f09b55ec`, merge
`87b7224c`); characterization is merged (`b75e36db`, merge `f12181e0`), with
four confirmed defects and one downgraded candidate. The four repair
dispositions were approved on 2026-08-14; implementation is deferred to a new
session.**

## Goal

Repair harness guards whose proxy signal can destroy legitimate work.

The governing rule is:

> The harness may measure and contain work. It must not silently interpret a
> weak proxy as proof that productive work is invalid.

Budget judgment for turns, time, cost, and stall evidence is owned by
[`run-budget-stall-escalation.md`](./run-budget-stall-escalation.md), not here.
Shell changes must preserve [`background-shell-monitor/MAP.md`](./background-shell-monitor/MAP.md).
Provider or run-loop changes require the provider black-box suite.

## Resume here

The retry/recovery budget contract is that ordinary successful tool-loop
continuations do not consume the physical recovery-attempt allowance. Recovery
handlers claim the physical dispatch when they schedule a `retry_fresh` plan,
while `RetryingModel` claims only its own post-failure provider retries. The
regression is covered by `source/providers/retrying-model.test.ts`.

Discovery is done and **it did not pay**. Five keyword sweeps produced 3,738 raw
hits across ~150 non-test files and ~30 enforcement owners; 260 non-test `throw
new` sites were enumerated and traced. That yielded exactly **one** confirmed
defect — a three-line wiring omission — plus four reasoned candidates.

Two consequences, both deliberate:

1. **Do not re-run the sweeps.** They are recorded below, they were exhaustive
   for named constants and throws, and by construction they cannot catch a guard
   written as an inline literal comparison. Another pass buys nothing. Future
   guard work starts from an observed incident or from the candidate list.
2. **The reference table is not a work queue.** Roughly 25 guards were catalogued
   with no hypothesized failure mode. They are listed so the next reader does not
   re-derive them — not because each owes a characterization test.

Open work, in order:

- **Completed:** `agent.maxParallelToolCalls` repair approved, verified, and
  merged (`f09b55ec`, merge `87b7224c`).
- **Completed:** all five candidates characterized and merged (`b75e36db`,
  merge `f12181e0`); results are recorded below.
- **Completed:** the four repair dispositions below were approved on
  2026-08-14. This approval changes no runtime or test behavior.
- **In progress:** the subagent steering mailbox repair is implemented and
  verified and merged (`74323696`, merge `fa328291`).
- **Completed:** tool ownership lifecycle repair is implemented and merged
  (`184db508`, merge `faa737c5`).
- **Completed and merged (`8d0e7f7a`):** `GenerationGuard` reasoning-length
  false positive. Verbose high-effort reasoning of ~100k characters on one
  request was aborting the turn as `reasoning_characters` /
  `unsafeToReplay`. The 100k cap is retained as a truncate bound; it no
  longer fails the request. See the repair record below.
- **Completed (this branch, pending merge; `d16bd5e3`):** destructive repetition
  inference is removed from both execution owners while the typed
  100,000-character aggregate visible-output cap remains. The InputSurgeGuard
  capability repair remains a separate worktree and rollback boundary.
- **Completed (branch `retry-recovery-contract`, pending merge to main):** the
  retry/recovery containment budget (`RetryRecoveryBudget`: 90s / 3 physical
  attempts / 1 automatic replay) and its never-replay-after-committed-output
  precondition. Four confirmed false-positive/settlement defects repaired
  across seven commits (`a00a899f` `3d9dab32` `839d2781` `66abfcec`
  `e353680f` `28a18aab` `a7e44292`); see the full entry below.

## Guard classes

| Class | Examples | Correct contract |
| --- | --- | --- |
| Inactivity watchdog | WebSocket first/inter-frame silence | Reset only on activity that proves the watched transport is alive; expire into a typed, recoverable transport failure. |
| Containment budget | wall time, cost, turns, workflow runtime | Progress is evidence, not an automatic unlimited extension. Warn or escalate before destructive settlement where the owner design permits it. |
| Admission limit | child count, depth, concurrency, workflow run count | Reject before starting new work; never abort unrelated admitted work. |
| Context/loss bound | tool result bytes, retained messages | Preserve or make the omitted material retrievable, and tell the consumer exactly what happened. |
| Runaway detector | repeated model output, identical failures | Require evidence specific to the runaway class; do not equate ordinary repetition with a loop. |
| Advisory guard | repeated-failure guidance | May steer behavior, but must not fabricate execution failure or become stale after the evidence is invalidated. |

There is deliberately no rule that "visible progress disables a limit." A noisy
infinite process is still infinite. Progress resets an *inactivity* detector; for
a containment budget it is evidence supplied to the judge described by the
run-budget plan.

`boundToolResultText` is the reference design for a context bound: it bounds
model context, spools the complete payload to an artifact, and appends a
retrieval path. It is the only row that arrived `verified safe`.

## Confirmed defect: `agent.maxParallelToolCalls` never reaches the run loop

The chain breaks at the last hop:

```text
settings-schema.ts:87-92     agent.maxParallelToolCalls, int, positive, default 3
settings-schema.ts:956       DEFAULT_SETTINGS.agent.maxParallelToolCalls = 3
settings-sources.ts:26       exposed with a value/source pair
utils/settings-command.ts    shown in /settings; on change the UI reports
                             "takes effect on the next request."
        --- no consumer ---
application-run-loop.ts:169  deps.maxParallelToolCalls?: number  (declared, never supplied)
application-run-loop.ts:343  Math.max(1, Math.floor(deps.maxParallelToolCalls ?? 4))
```

All three construction sites — `lib/agent-client.ts:373`,
`services/subagents/nested-runner.ts:397`, `services/subagents/mentor-runner.ts:304`
— omit the field. A repo-wide search returns only the schema, source map,
settings UI, and the run loop itself.

So the effective width is always the code fallback `4`, never the schema default
`3`, on every path including subagents. A user who lowers the value to reduce
concurrency silently keeps four parallel calls, and the UI confirms a change that
did not happen.

**Repair (needs approval — it changes the effective default from 4 to 3 for every
user):** pass the resolved setting at the three construction sites, assert the
effective value through the public owner, and use the `setting-wiring` skill.

**Follow-up that closes the class:** `maxTurns` shows the same divergence shape
(interactive `100` versus AgentRuntime fallback `20`). A contract test asserting
every `SETTING_KEYS` entry has a consumer outside the schema, source map, and
settings UI would catch this defect class automatically.

### Approved repair contract (2026-08-14)

```text
Harm prevented: configured concurrency silently exceeding the user's limit.
Scope and execution paths: root, nested-subagent, and mentor run loops.
Guard class: concurrency containment (admission batching; calls are deferred, not rejected).
Enforcement owner: ApplicationRunLoop tool-plan settlement.
Recovery owner: ApplicationRunLoop ordered batch settlement.
Measured signal and observation boundary: contiguous parallel-safe calls in one completed model response.
Direct evidence or proxy: direct count of calls admitted to the current batch.
Legitimate work that can produce the same signal: a response containing many independent safe calls.
Configuration sources and precedence: ISettingsService resolution, including persisted/user values over schema default.
Effective default and clamping: 3; floor to an integer and clamp to at least 1 at each response settlement.
Action and why the signal justifies it: dispatch at most the effective width and defer the remainder to later batches.
Partial-work settlement: unchanged; results remain ordered and every admitted call settles once.
Retry, fallback, and provider-continuity semantics: unchanged.
Observability fields: batch diagnostic includes call ids, order, parallel flag, and effective width.
Persisted-setting migration, if any: none; no stored value is rewritten.
Rollback boundary: one independently revertible commit.
Ledger row: confirmed defect, agent.maxParallelToolCalls.
```

Approval: user approved changing the effective default from 4 to 3 on
2026-08-14. Red proof before production changes:

```text
NODE_ENV=test pnpm test source/lib/agent-client.application-run-loop.test.ts
FAIL applies a changed maxParallelToolCalls setting to the next request
expected ["first"], received ["first", "second"]
```

Disposition: **repaired in `f09b55ec` and merged in `87b7224c`.** The run loop
now resolves the effective setting at each completed-response settlement, so a
runtime change applies to the next dispatch boundary without resizing a batch
already in flight. Root, nested, and mentor construction paths all supply the
resolver; the owner fallback now agrees with the schema default of 3.

Detection gap: schema, persistence, and settings-command tests proved only that
the value existed and could be changed. Nothing exercised the configured value
through the execution owner. The new AgentClient public-boundary regression
covers both runtime refresh and the exact-width/one-over boundary. The proposed
all-settings consumer contract remains coupled to the `maxTurns` divergence
owned by `run-budget-stall-escalation.md`, so it was not introduced here.

Verification (2026-08-14):

```text
NODE_ENV=test pnpm test source/lib/agent-client.application-run-loop.test.ts \
  source/tools/agent/run-subagent.test.ts \
  source/services/subagents/nested-runner.test.ts \
  source/services/subagents/mentor-runner.test.ts \
  source/hooks/settings-completion-logic.test.ts \
  source/components/menu/SettingsSelectionMenu.test.tsx \
  source/utils/settings-command.test.ts \
  source/services/settings/settings-schema.test.ts
PASS 8 files, 111 tests

pnpm typecheck
PASS

pnpm exec prettier --check <changed-files>
PASS

pnpm test:provider-black-box
PASS 19 files, 166 tests; 1 skipped

NODE_ENV=test pnpm test
PASS 480 files; 1 skipped. 6149 tests; 2 skipped.
Note: emitted an existing TimeoutNaNWarning; no test failed.
```

## Candidates to characterize

This is the original candidate list. Each named a mechanism-level contradiction,
not a hunch; the characterization results below supersede its initial
`candidate` status.

| Guard | Source | Contradiction | Test to write |
| --- | --- | --- | --- |
| Subagent steering mailbox | `subagent-run-control.ts`; 4 messages / 4000 chars | Shifts the oldest message off and prepends `[Earlier steering omitted]`. The marker announces the omission but the text is spooled nowhere, so it is irrecoverable — this fails the context-bound contract. | Burst of user steering during one subagent turn. |
| Conversation log event size | `conversation-log-writer.ts`; `MAX_EVENT_BYTES=256KiB`, strings over 1024 chars truncated, then a stub event | This is persisted replay state, so the logging-only exclusion does not apply. | Replay a session containing a truncated `tool_result`. |
| Tool ownership claim eviction | `tool-ownership-registry.ts`; `DEFAULT_LIMIT=500`, evicts oldest | The code comment assumes claims are dead weight after approval, but eviction is count-based, not liveness-based. | Can a still-pending approval lose its owner? |
| Duplicate repetition detectors | shared `GenerationGuard` (100k chars/channel, 4096x3 periodic suffix, typed `unsafeToReplay`) and the foreground session detector (200 repeated chars over 8 repetitions, throws an older untyped error) | Two owners, different thresholds, incompatible recovery. The foreground one trips at a far smaller repetition. | Characterize both together: valid exact-periodic output above 200 and above 4096 chars; threshold minus one / threshold / plus one; genuine runaway. If the foreground guard can reject valid output, prefer deleting it over tuning two detectors. |
| `InputSurgeGuard` bypass scope | blocks 3 duplicated call/result IDs at 2 copies, or 20 duplicated signatures at 4 copies; pauses dispatch for explicit confirmation with a one-turn bypass | A bypass that leaks across turns is a cross-turn authorization defect. | Legitimate full-history input reaches confirmation; cancel and confirm paths; the bypass cannot attach to replacement or queued input. |

Use fake timers and fake providers/processes. Never place destructive command
examples in ad-hoc shell probes — keep them as data in fixture files.

**Gate:** each candidate has one fast deterministic command already run red
against the exact suspected false positive, or is downgraded with evidence.
Present the results before any behavior change.

### Characterization results

- **Subagent steering mailbox — confirmed defect (2026-08-14).** A public
  `SubagentAsyncRegistry` characterization queued five messages while one tool
  was active. Every `sendMessage` returned `{ ok: true, delivery: "queued" }`,
  but the continuation contained only messages 2–5 plus
  `[Earlier steering omitted]`; message 1 was neither delivered nor
  retrievable. Red command:
  `NODE_ENV=test pnpm test source/services/subagents/subagent-async-registry.test.ts -t "delivers every steering message it acknowledges as queued"`.
  The temporary characterization test was removed after recording the failure;
  no behavior change has been made.
- **Conversation log event size — downgraded; no runtime guard (2026-08-14).**
  `truncateForLog` and `MAX_EVENT_BYTES` have no production caller; the helper
  is only exposed through `__testing`. `ConversationLogWriter.append` serializes
  the sanitized event directly. A writer-to-decoder-to-replay test persisted a
  300,000-character `tool_result` with a tail retrieval reference and recovered
  that reference successfully. Green command:
  `NODE_ENV=test pnpm test source/services/logging/conversation-log-writer.test.ts -t "preserves a large tool result retrieval reference through replay"`.
  The regression test is retained; the dead helper may be removed separately
  but cannot truncate replay state today.
- **Tool ownership claim eviction — confirmed defect (2026-08-14).** Claims
  are created only when a nested approval is surfaced, but production has no
  `ToolOwnershipRegistry.release` caller. The registry therefore has no
  liveness evidence when count overflow evicts its oldest claim. A temporary
  characterization with `limit: 2` kept the first claim unreleased, added two
  later claims, and observed `ownerOf("pending")` fall back from the worker to
  `{ kind: "parent" }`. Red command:
  `NODE_ENV=test pnpm test source/services/approval/tool-ownership-registry.test.ts -t "does not evict an unreleased pending ownership claim"`.
  The temporary test was removed; no behavior change has been made.
- **Duplicate repetition detectors — confirmed defect (2026-08-14).** Both
  owners reject legitimate exact-periodic fixed-width data based on repetition
  alone. The foreground `RepetitionDetector` returned `true` for a
  200-character block (`"..........##########"` repeated ten times); its
  existing split-chunk test already pins 195 characters as allowed and 200 as
  rejected. Red command:
  `NODE_ENV=test pnpm test source/services/session/repetition-detector.test.ts -t "does not flag a legitimate fixed-width periodic data block at 200 characters"`.
  The shared `ApplicationRunLoop` guard rejected a 4,096-character block with
  `GenerationGuardError { code: "repetitive_text", unsafeToReplay: true }`.
  Red command:
  `NODE_ENV=test pnpm test source/services/agent-runtime/application-run-loop.test.ts -t "allows a legitimate fixed-width periodic data block at the default repetition boundary"`.
  Existing tests retain genuine-runaway coverage. The temporary false-positive
  tests were removed; no behavior change has been made.
- **`InputSurgeGuard` bypass scope — confirmed replacement leak
  (2026-08-14).** Existing `ConversationAdmissionWorkflow` tests prove that a
  caller-supplied bypass is stripped, only a matching surge approval creates
  one, decline sends nothing, and stale/repeated confirmation IDs cannot create
  a later bypass. The queued edit path is different: `editSubmission` replaces
  the message input but preserves its options. A temporary adapter test edited
  an approved queued surge and observed the replacement start with
  `bypassInputSurgeGuard: true`. Red command:
  `NODE_ENV=test pnpm test source/services/conversation/conversation-adapter.test.ts -t "does not attach an approved input-surge bypass to replacement queued content"`.
  The temporary test was removed; no behavior change has been made.

Characterization checkpoint verification:

```text
NODE_ENV=test pnpm test source/services/logging/conversation-log-writer.test.ts
PASS 1 file, 15 tests

pnpm typecheck
PASS

pnpm exec prettier --check docs/plans/guard-ledger.md \
  source/services/logging/conversation-log-writer.test.ts
PASS
```

### Approved repair dispositions

Approved on 2026-08-14 for implementation in a new session. This decision
record does not authorize unrelated guard changes and does not itself change
runtime or test behavior.

1. **Subagent steering mailbox — reject before overflow.** Treat the four-message
   and 4,000-character bounds as admission limits. Reject a new steering message
   before enqueueing it when either effective bound would be exceeded, and
   return a typed non-success acknowledgement that reports the effective limits
   and current occupancy. Never acknowledge a message as queued and then discard
   it. Preserve already admitted guidance and the current active-tool and
   continuation semantics.
2. **Tool ownership claims — make retention lifecycle-aware.** Pending ownership
   claims must not be count-evicted. Release each claim exactly once when its
   approval settles through success, rejection, cancellation, failure, or
   session cleanup. Bounded cleanup may remove only released or otherwise proven
   dead claims. Public-owner tests must cover each settlement path and prove the
   oldest live claim retains its owner under pressure.
3. **Duplicate repetition detectors — remove destructive repetition inference.**
   Remove both repetition-only abort paths: the foreground 200-character/8-copy
   detector and the shared 4,096-character/3-copy detector. Retain the explicit
   100,000-character generation-output containment limit. Repetition may remain
   diagnostic or advisory, but must not fabricate a terminal failure or an
   `unsafeToReplay` classification. Tests must prove valid periodic output
   survives and genuine unbounded output reaches the retained containment owner.
4. **`InputSurgeGuard` bypass — bind approval to immutable submitted content.**
   Replace the free/leaky bypass boolean with an approval capability bound to the
   exact submitted turn identity and content. Editing or replacing that content
   invalidates the capability and sends the replacement through normal admission
   and confirmation. Preserve the existing decline, stale-confirmation, repeated-
   confirmation, and caller-supplied-bypass protections.

### InputSurgeGuard content-bound approval repair

Disposition: **implemented in `c3c8ef25`.**
`InputSurgeApproval` is an opaque, one-use capability whose module-private
provenance record carries a canonical normalized `UserTurn` snapshot: text,
every image field, and every skill field. The admission workflow issues it only
when the matching surge confirmation is approved. The execution admission owner
(`InitialInputPreparer`) consumes and validates it against the exact normalized
submitted turn before allowing a blocked provider request. A caller-supplied
lookalike has no module-private provenance and cannot bypass the guard. Queue replacement drops
the stored capability before the edited message starts, so replacement content
follows ordinary surge blocking rather than inheriting the prior confirmation.
The aborted-approval internal path issues the same narrowly scoped,
content-bound one-use capability for the attempt it is resolving; it no longer
has a free boolean bypass.

```text
Harm prevented: an approval for one surge input authorizing edited, replacement,
  or caller-injected input on a later execution boundary.
Scope and execution paths: admission confirmation, foreground queue storage and
  edit, adapter-to-session start options, initial provider-request preparation,
  and aborted-approval internal resolution.
Guard class: advisory confirmation plus content-bound admission authority.
Enforcement owner: InitialInputPreparer at provider-request admission.
Recovery owner: ConversationAdmissionWorkflow confirmation; unchanged decline
  and stale/repeated-decision settlement.
Measured signal and observation boundary: exact normalized UserTurn content at
  the provider-request admission boundary, not a caller option or queue id.
Direct evidence or proxy: direct normalized text, images, and skill content.
Legitimate work that can produce the same signal: an unchanged queued turn after
  explicit approval; its capability is admitted once.
Action and why the signal justifies it: consume only a workflow-issued matching
  capability; otherwise retain the existing surge block and normal re-admission
  path.
Partial-work settlement: unchanged; an invalid capability blocks before a
  provider request and rolls back the just-added user turn as before.
Retry, fallback, and provider-continuity semantics: unchanged.
Observability fields: existing input_surge.blocked fields; no turn payload or
  capability is logged.
Persisted-setting migration, if any: none.
Rollback boundary: `c3c8ef25`.
Ledger row: InputSurgeGuard bypass scope.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm test source/services/conversation/conversation-admission-workflow.test.ts \
  source/services/conversation/conversation-adapter.test.ts \
  source/services/session/initial-input-preparer.test.ts
FAIL: approved surge send supplied bypassInputSurgeGuard: true instead of a
      capability; the capability contract module did not yet exist.
```

Detection gap: prior workflow tests proved only that a boolean was stripped at
the UI-facing admission call and that a confirmation id was one-shot. They did
not follow approval authority through queued-message replacement to the
execution admission boundary, nor mutate nested image or skill content after
approval. The new contract tests cover issued-only authority, one-use admission,
nested image and skill mutation, caller forgery, edit-away/edit-back invalidation,
mode-notice separation, workflow-to-orchestrator capability transport, and the
retained decline/stale/repeated-confirmation behavior.

Focused verification (`c3c8ef25`):

```text
NODE_ENV=test pnpm test source/services/conversation/conversation-admission-workflow.test.ts \
  source/services/conversation/conversation-adapter.test.ts \
  source/services/session/conversation-session.input-surge.test.ts \
  source/services/session/initial-input-preparer.test.ts \
  source/services/session/turn-coordinator.test.ts \
  source/services/conversation/conversation-orchestrator.test.ts \
  source/hooks/use-conversation.clear.test.tsx
PASS 7 files, 139 tests

NODE_ENV=test pnpm typecheck
PASS

NODE_ENV=test pnpm test:related <changed production files>
KNOWN BASELINE FAILURE: 73 files and 1,083 tests passed; the sole failure was
source/hooks/stop-processing-probe.test.tsx:75, the pre-existing blank final
frame recorded in MORNING.md.

NODE_ENV=test pnpm test:changed
KNOWN BASELINE FAILURE: same sole stop-processing probe failure; 73 files and
1,083 tests passed, with 2 expected failures.

NODE_ENV=test pnpm test:provider-black-box
PASS 19 files, 171 tests; 1 skipped

NODE_ENV=test pnpm test
KNOWN BASELINE FAILURE: 543 files passed, 1 failed, 1 skipped; 6,956 tests
passed, 1 failed, 3 expected failures, 2 skipped. The sole failure was the same
stop-processing probe and does not exercise input-surge admission.
```

### Duplicate repetition detector repair

 Disposition: **implemented and verified in `d16bd5e3`; merged into `main`.**
`GenerationGuard` no longer treats repeated text or reasoning as a terminal
failure, and `SessionStreamProcessor` no longer owns a second foreground
repetition abort. `RepetitionDetector` remains only as a bounded boolean
diagnostic primitive with no production enforcement caller. The direct aggregate
visible-output budget remains the enforcement owner: output beyond 100,000
characters still aborts the active request as typed `output_characters` and is
unsafe to replay, while already-forwarded output remains available.

```text
Harm prevented: legitimate periodic text or reasoning terminating a productive
  turn and being falsely classified unsafe to replay.
Scope and execution paths: shared ApplicationRunLoop model-stream consumption
  and the foreground SessionStreamProcessor path.
Guard class: repetition is an inconclusive runaway proxy; aggregate output is a
  containment budget.
Enforcement owner: GenerationGuard aggregate visible-output accounting.
Recovery owner: ApplicationRunLoop abort and ambiguous-outcome settlement for
  the retained output-character cap; repetition has no recovery path because it
  no longer fabricates failure.
Measured signal and observation boundary: cumulative visible text and streamed
  tool-argument characters on one provider request.
Direct evidence or proxy: direct character count for containment; periodicity is
  a proxy and no longer authorizes termination.
Legitimate work that can produce the removed signal: fixed-width tables, logs,
  generated data, and periodic reasoning split across provider chunks.
Configuration sources and precedence: existing GenerationGuard options and
  model settings; no value or precedence changed.
Effective default and clamping: aggregate visible output remains 100,000
  characters by default; existing positive-integer resolution is unchanged.
Action and why the signal justifies it: repetition has no terminal action;
  exceeding the explicit aggregate budget aborts and reports output_characters.
Partial-work settlement: already-forwarded output is retained; cap overflow
  aborts before forwarding the triggering chunk.
Retry, fallback, and provider-continuity semantics: cap overflow remains an
  AmbiguousModelOutcomeError and unsafe to replay; repetition no longer enters
  retry classification.
Observability fields: retained typed output_characters code and counts; removed
  repetitive_text, repetitive_reasoning, repetitive_model_output terminal codes.
Persisted-setting migration, if any: none.
Rollback boundary: independently revertible `d16bd5e3`.
Ledger row: duplicate repetition detectors.
```

Red proof before production edits:

```text
NODE_ENV=test pnpm test source/services/agent-runtime/generation-guard.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/session/session-stream-processor.test.ts
FAIL 5 tests: legitimate periodic output terminated as repetitive_text or
repetitive_model_output; the aggregate-cap test was preempted by repetition.
```

Detection gap: both owners' tests encoded repetition-only termination as desired
behavior. They did not challenge the proxy with legitimate periodic output at
the public execution boundaries or assert that the explicit aggregate budget,
rather than repetition, remained the terminal containment owner.

Verification is recorded in `EXPERIMENT-P2.md`; implementation commit:
`d16bd5e3`.

### Subagent steering mailbox repair

Disposition: **repaired in `74323696` and merged in `fa328291`.**
`SubagentRunControl` now treats its four-message and 4,000-character
bounds as admission limits. `enqueueSteering` returns false before either bound
would be exceeded, without mutating the mailbox or interrupting the active
segment. `SubagentAsyncRegistry.sendMessage` translates that result into the
typed `mailbox_full` non-success acknowledgement with the effective limits and
current occupancy. Already admitted messages retain their order and are all
delivered in the next continuation.

```text
Harm prevented: acknowledged user steering being silently discarded.
Scope and execution paths: active async subagent runs addressed by run id or name.
Guard class: admission limit with a secondary retention consequence.
Enforcement owner: SubagentRunControl mailbox admission.
Recovery owner: SubagentAsyncRegistry acknowledgement and normal continuation settlement.
Measured signal and observation boundary: queued message count and summed message characters before enqueue.
Direct evidence or proxy: direct mailbox occupancy.
Legitimate work that can produce the same signal: a burst of valid steering while tools remain active.
Configuration sources and precedence: SubagentRunControl constructor injection over hardcoded defaults.
Effective default and clamping: 4 messages and 4,000 characters; unchanged, with no persisted setting.
Action and why the signal justifies it: reject only the new message before admission and report capacity.
Partial-work settlement: admitted guidance remains ordered and the active segment is untouched by rejection.
Retry, fallback, and provider-continuity semantics: unchanged; the caller may retry after continuation drains the mailbox.
Observability fields: mailbox_full, target, effective limits, and current occupancy; no guidance text.
Persisted-setting migration, if any: none.
Rollback boundary: one independently revertible commit.
Ledger row: subagent steering mailbox.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm test source/services/subagents/subagent-async-registry.test.ts \
  -t "rejects a fifth steering message before overflow"
FAIL: expected mailbox_full; received { ok: true, delivery: "queued" }
```

Detection gap: the prior unit tests asserted the truncation marker and therefore
encoded information loss as intended behavior. No public-registry test paired
successful queue acknowledgements with the exact guidance later delivered. The
new tests cover both effective bounds, preservation and ordering of admitted
messages, no active-segment interruption on rejection, typed tool output, and
the public acknowledgement shape.

Verification:

```text
NODE_ENV=test pnpm test source/services/subagents/subagent-run-control.test.ts \
  source/services/subagents/subagent-async-registry.test.ts \
  source/tools/agent/run-subagent-async.test.ts
PASS 3 files, 109 tests

pnpm typecheck
PASS

pnpm test:provider-black-box
PASS 19 files, 166 tests; 1 skipped

NODE_ENV=test pnpm test
PASS 480 files; 1 skipped. 6153 tests; 2 skipped.
Note: emitted the existing TimeoutNaNWarning; no test failed.
```

### Tool ownership lifecycle repair

Disposition: **repaired in `184db508` and merged in `faa737c5`.**
`ToolOwnershipRegistry` no longer count-evicts live claims. Claims remain until
an approval decision, abort, adopted-child cancellation or settlement, queue
closure, or session-handle cleanup releases them. Decision settlement releases
in a `finally` block, so callback failures cannot strand ownership.

```text
Harm prevented: a still-pending nested approval silently losing its subagent owner.
Scope and execution paths: foreground nested approvals, adopted background-subagent approvals, and session cleanup.
Guard class: retention bound with lifecycle-owned release.
Enforcement owner: ToolOwnershipRegistry claim retention.
Recovery owner: approval decision, approval abort, foreground lease, background approval queue, and session handle lifecycle owners.
Measured signal and observation boundary: explicit pending-call claim and terminal lifecycle events.
Direct evidence or proxy: direct claim identity and settlement events; no count proxy remains.
Legitimate work that can produce the old signal: more than 500 simultaneously or historically claimed approvals.
Configuration sources and precedence: legacy constructor limit injection is retained for source compatibility but no longer evicts live claims.
Effective default and clamping: no live-claim count limit; lifecycle release and session clear bound retention.
Action and why the signal justifies it: delete only the exact claim proven settled or all claims during session-handle disposal.
Partial-work settlement: approval continuation and child lease settlement remain unchanged; only attribution retention changes.
Retry, fallback, and provider-continuity semantics: unchanged.
Observability fields: unchanged; ownership remains queryable while live.
Persisted-setting migration, if any: none.
Rollback boundary: one independently revertible commit.
Ledger row: tool ownership claim eviction.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm test source/services/approval/tool-ownership-registry.test.ts \
  -t "does not evict an unreleased pending ownership claim"
FAIL: expected worker owner; received parent fallback
```

Detection gap: registry tests encoded oldest-first count eviction as intended,
while no public approval lifecycle test asserted that ownership survived until
settlement or was released afterward. The repair adds pressure retention plus
approve, reject, callback failure, abort, abort resolution, adopted-background
resolution, queue close, lease cancellation, and lease settlement coverage.

Focused verification:

```text
NODE_ENV=test pnpm test source/services/approval/tool-ownership-registry.test.ts \
  source/services/approval/approval-decision-executor.test.ts \
  source/services/approval/approval-flow-coordinator.test.ts \
  source/services/approval/background-subagent-approval-controller.test.ts \
  source/services/subagents/foreground-subagent-lease.test.ts \
  source/services/subagents/nested-runner.test.ts \
  source/services/session/session-composition.test.ts
PASS 7 files, 111 tests

pnpm typecheck
PASS

NODE_ENV=test pnpm test
PASS 480 files; 1 skipped. 6159 tests; 2 skipped.
Note: emitted the existing TimeoutNaNWarning; no test failed.

pnpm test:provider-black-box
UNVERIFIED: two attempts each failed a different 15-second PTY wait
(interactive public-hook startup, then Runtime OpenAI stateless startup). The
focused and full suites passed; neither timeout exercised tool ownership.
```

### GenerationGuard reasoning-length false positive

Incident 2026-08-27: term2 + deepseek-v4-flash at high reasoning effort died
with `Model output was stopped because reasoning exceeded its limit.` after
~17 minutes. Both failing runs streamed ~100,100 characters of reasoning
after the last completed tool call, then threw at
`generation-guard.ts` `#assertReasoningLength`. Prior tools were reads only,
so the git diff was empty. pi completed the same model, effort, and tasks
with no equivalent guard. The cap is cumulative per request, not per-chunk.
`GenerationGuardError` extends `AmbiguousModelOutcomeError`, so retry
classifies the throw as unrecoverable — replaying would hit the same cap.

The 100,000-character number is retained. The defect was the action: aborting
the request treated productive verbose reasoning as proof the work was
invalid. Reasoning no longer consumes the aggregate output budget, or a full
thought would starve later text and tool calls.

```text
Harm prevented: a verbose high-effort reasoner aborting a productive turn
  once thinking crosses 100k characters, discarding later text and tool calls.
Scope and execution paths: ApplicationRunLoop model-stream consume, including
  non-interactive stderr reasoning_delta.
Guard class: containment budget (reasoning volume) with a retention bound.
Enforcement owner: GenerationGuard.observeReasoning / observeCompletion.
Recovery owner: none; overflow truncates in place and the request continues.
Measured signal and observation boundary: cumulative reasoning characters on
  one provider request, counted from reasoning_delta and completion reasoning.
Direct evidence or proxy: direct character count of the reasoning channel.
Legitimate work that can produce the same signal: high-effort coding models
  that think at length before the first write (observed: 100,100 chars after
  the last tool, then abort).
Configuration sources and precedence: agent.maxStreamOutputChars via
  modelSettings, then GenerationGuardOptions, then 100_000 default.
Effective default and clamping: 100,000 characters retained; excess dropped;
  integer-positive setting unchanged.
Action and why the signal justifies it: stop forwarding reasoning past the
  cap so assembled output stays bounded; do not abort, because volume of
  thinking is not evidence of a loop. Text and tool-argument caps remain
  fail-closed.
Partial-work settlement: already-forwarded reasoning is kept; later text,
  tool calls, and completion still settle; dropped reasoning is not spoolable
  (display-only scratch, not user work product).
Retry, fallback, and provider-continuity semantics: unchanged. Native
  encrypted / reasoning_content metadata is still taken from provider
  metadata, not from the truncated display prefix.
Observability fields: existing GenerationGuardError codes for text, tools,
  repetition, and deadline; reasoning length no longer throws.
Persisted-setting migration, if any: none.
Rollback boundary: one independently revertible commit.
Ledger row: GenerationGuard reasoning-length false positive.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-runtime/generation-guard.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  -t "truncates streamed reasoning|accepts reasoning at the character cap"
FAIL: GenerationGuardError { code: "reasoning_characters", unsafeToReplay: true }
```

Detection gap: existing tests encoded abort-on-reasoning-length as intended
and never sent later text after the cap. The incident is a class of
verbose-but-finite reasoning, not a loop.

Focused verification (2026-08-27):

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-runtime/generation-guard.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts
PASS 2 files, 76 tests

NODE_ENV=test pnpm exec tsc --noEmit
PASS

NODE_ENV=test pnpm test:related \
  ./source/services/agent-runtime/generation-guard.ts \
  ./source/services/agent-runtime/application-run-loop.ts \
  ./source/hooks/settings-completion-config.ts
PASS 127 files, 2066 tests; 2 expected fail; 1 skipped

NODE_ENV=test pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  -t "stops runaway streamed output"
PASS 4 tests (openai/codex × http/websocket)

pnpm test:provider-black-box
FLAKE: two full-suite attempts each failed a different 15s PTY wait
(openai websocket incomplete-stream, then public-hooks interactive startup).
CLI sat at idle with 0 captured requests. Same class as the ledger's earlier
unverified PTY timeouts; not exercised by the reasoning-length change.
```

### GenerationStreamDeadlines total-deadline false positive (provider-neutral inactivity watchdog)

Incidents: 2026-08-27 OpenRouter `z-ai/glm-5.3-flash` and 2026-08-21 Neuralwatt
`kimi-k3-flex` both aborted with `request_deadline` at the 300s
`agent.maxModelRequestDurationMs` default. Log review showed neither was a
runaway: Kimi was actively streaming text+reasoning ~25s before the cut, and
GLM buffered its whole answer and delivered it ~2 min *after* the deadline. The
300s limit was a **total** wall-clock that cannot tell slow-but-active work from
a stall. Codex already had a transport inactivity watchdog
(`websocket-receive-watchdog.ts`, 90s first-frame / 600s inter-frame) that
re-arms on any frame — but it covers only the Codex WebSocket transport. Every
other provider fell back to the crude total deadline.

Repair: the generation guard now owns a **provider-neutral** inactivity window
(`GenerationStreamDeadlines`) that re-arms on every streamed event in
`ApplicationRunLoop.consume`. The total wall-clock becomes an opt-in backstop,
default off. A single 600s idle window (matching Codex's proven inter-frame)
lets Kimi survive (streams → re-arms) and GLM survive (its single late frame
arrives inside the window), while a genuinely silent request is still cut at
600s.

```text
Harm prevented: a stalled/hung provider request burning unbounded time with no
  output AND a slow-but-active model being aborted mid-work by a total deadline.
Scope and execution paths: every model.stream request in
  ApplicationRunLoop.consume (root, subagent, non-interactive, shell — one loop).
Guard class: inactivity watchdog (primary) + opt-in containment budget (total
  ceiling, default off).
Enforcement owner: GenerationStreamDeadlines in generation-guard.ts, driven by
  ApplicationRunLoop.consume via deadline.recordActivity() on each event.
Recovery owner: retry classifier; GenerationGuardError extends
  AmbiguousModelOutcomeError → unsafeToReplay, no blind re-dispatch.
Measured signal and observation boundary: wall-clock gap since the last streamed
  event, observed in the consume() loop; total elapsed for the opt-in ceiling.
Direct evidence or proxy: proxy (silence). Justified for an inactivity watchdog
  because absence of ANY streamed frame for the window is the transport-neutral
  signature of a stall; active reasoning emits deltas that re-arm it.
Legitimate work that can produce the same signal: long high-effort reasoning
  (emits reasoning deltas → re-arms) and buffered providers that send the whole
  answer in one late frame within the window.
Configuration sources and precedence: options.generationGuard (per-request) >
  modelSettings.maxModelStreamIdleMs / maxModelRequestDurationMs (settings) >
  DEFAULT_GENERATION_GUARD_OPTIONS.
Effective default and clamping: maxModelStreamIdleMs default 600_000;
  maxModelRequestDurationMs default 0 = off. Both nonnegative; <=0 disables that
  timer.
Action and why the signal justifies it: abort the active request and throw
  GenerationGuardError (code 'stream_inactivity' or 'request_deadline').
Partial-work settlement: cost record marked failed/cancelled; streamed progress
  counts carried in the error message (survives the subagent tool-output string).
Retry, fallback, and provider-continuity semantics: AmbiguousModelOutcomeError,
  not auto-replayed; continuity unchanged.
Observability fields: error code, configured window, streamed progress counts.
Persisted-setting migration, if any: settings-schema drops the 0→300_000
  coercion so 0 now means "off"; default 300_000 → 0. The existing
  migrateFormerRequestDeadlineDefault (persisted 300_000 → 0) becomes effective.
  Configs holding an explicit positive value keep it as the total ceiling.
Rollback boundary: revert generation-guard.ts + run-loop wiring + settings +
  agent-factory/agent-configuration + completion-config, one branch.
Ledger row: GenerationStreamDeadlines total-deadline false positive.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-runtime/application-run-loop.test.ts \
  -t "stream_inactivity"
FAIL: Test timed out — no idle guard aborted the stalled stream.

NODE_ENV=test pnpm exec vitest run \
  source/services/settings/settings-schema.test.ts -t "stream-idle"
FAIL: expected undefined to be 600000 (maxModelStreamIdleMs did not exist).
```

Detection gap: the total deadline was only tested for the runaway (abort) case
and for "no default deadline" — no test asserted that a slow-but-active or
buffered provider survives, so a total wall-clock reading as a stall went
uncaught. The new reset-on-delta test closes that class.

Focused verification (2026-08-28):

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-runtime/generation-guard.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/settings/settings-schema.test.ts
PASS 3 files, 109 tests

NODE_ENV=test pnpm typecheck
PASS

pnpm test:provider-black-box
PASS 19 files, 171 tests; 1 skipped
```

### Test contracts by class

A repair for a candidate must satisfy its class contract.

- **Inactivity:** silence reaches the typed error; each meaningful raw event
  resets the right timer; an event with no normalized text switches first-frame
  to inter-frame; retry/fallback preserves provider continuity.
- **Admission:** rejection happens before the work starts; admitted work stays
  active; capacity releases exactly once on success, failure, and cancellation;
  the rejection carries the effective limit and current count.
- **Context and retention:** the consumer is told what was omitted; omitted
  material is retrievable, or the terminal status explicitly says it is not;
  UTF-8 and structured payload boundaries stay valid; eviction never aborts
  active work; replay retains retrieval references.
- **Runaway and advisory:** the genuine pattern goes red through the intended
  path; valid periodic output above the threshold does not false-positive, or the
  trade-off is explicitly accepted and explained; boundaries are deterministic;
  advisory guards never fabricate that a tool was not executed.

### Shell repair constraints

If shell containment is ever repaired, these hold regardless of the fix chosen:

- stdout alone never grants unlimited runtime — do not convert the total timeout
  into an activity timeout;
- sandbox network-approval time stays excluded from the command budget;
- process-group cleanup and hard settlement remain bounded;
- partial output and terminal status stay truthful;
- foreground/background transfer and monitoring reuse existing owners.

Current behavior: foreground default 120s, background 30m, per-call `timeout_ms`
wins, SIGTERM then SIGKILL; foreground retained-buffer overflow (1MiB) kills
while background truncates and keeps running.

### Foreground nested shell approval false positive

Disposition: **repaired locally on 2026-08-14; not yet committed or merged.**
Foreground nested workers now honor `shell.autoApproveMode=always` at the same
subagent tool-policy boundary as ordinary and background workers. Hard execution
constraints remain in `execute`: subagents still reject an explicit
`sandbox: "unsandboxed"`, out-of-workspace write targets, and lock conflicts.

```text
Harm prevented: a legitimate foreground nested worker test or shell command terminalizing the worker at an approval pause while YOLO mode is active.
Scope and execution paths: foreground nested worker shell calls built with nestedApprovals=true.
Guard class: advisory approval gate; this is a false-positive removal, not an authority expansion.
Enforcement owner: SubagentToolPolicy.wrapNestedShellTool.
Recovery owner: NestedSubagentRunner only for genuine non-YOLO approval pauses; unchanged.
Measured signal and observation boundary: the effective shell.autoApproveMode setting at each shell approval check.
Direct evidence or proxy: direct effective setting value.
Legitimate work that can produce the old signal: validation commands while YOLO has disabled the sandbox.
Configuration sources and precedence: ISettingsService effective shell.autoApproveMode resolution.
Effective default and clamping: unchanged; only the exact always value bypasses the underlying approval decision.
Action and why the signal justifies it: return needsApproval=false in always mode, matching ordinary worker and root shell policy.
Partial-work settlement: unchanged; the command executes and settles normally instead of returning an interrupted partial result.
Retry, fallback, and provider-continuity semantics: unchanged.
Observability fields: unchanged.
Persisted-setting migration, if any: none.
Rollback boundary: SubagentToolPolicy nested-shell wrapper plus its focused contract tests.
Ledger row: foreground nested shell approval false positive.
```

Red proof before the production change:

```text
NODE_ENV=test pnpm exec vitest run source/services/subagents/tool-policy.test.ts \
  --testNamePattern='foreground nested worker shell auto-approval'
FAIL: expected false, received true
```

Detection gap: always-mode coverage exercised `wrapShellTool`, while foreground
nested execution selects the separate `wrapNestedShellTool`; no test compared
the effective approval policy across those sibling execution paths.

The observed approval pause exposed a second settlement gap: interrupted
foreground runs deliberately emitted no `subagent_completed` event, but had no
truthful alternative terminal event. Their transcript card therefore remained
`running`, kept all later messages outside Ink's static region, and eventually
triggered `Static blocked: subagent/running`. The repair adds a distinct
`subagent_interrupted` event through runner, bridge, logging/replay, handler,
and rendering. The matching parent-tool `command_message` provides an
idempotent call-ID-scoped fallback if that lifecycle event is missed; unrelated
later messages and background cards cannot settle the row. The repair does not
mislabel the run completed or make it resumable.

Verification:

```text
NODE_ENV=test pnpm exec vitest run source/services/subagents/tool-policy.test.ts \
  source/services/subagents/subagent-manager.security.test.ts \
  source/services/subagents/nested-runner.test.ts
PASS 3 files, 71 tests

pnpm typecheck
PASS

pnpm exec prettier --check <changed-files>
PASS

NODE_ENV=test pnpm test
PASS unrestricted: 483 files passed; 1 skipped. 6202 tests passed; 2 skipped.
Restricted run: 68 environment failures from listen EPERM, PTY/subprocess IPC,
and missing child-process output; the same suite passed with those facilities enabled.

pnpm test:provider-black-box
PASS 19 files, 166 tests; 1 skipped
```

### Global YOLO approval bypass with ask_user exception

Disposition: **repaired locally on 2026-08-16; pending commit and merge.**
shell.autoApproveMode=always is now a shared no-permission policy for root
turns, continuations, nested workers, native and application editor tools,
direct shell definitions, and application-owned post-execute permission gates.
The ask_user tool is deliberately excluded because it collects user input; it
is not an authority decision and must still suspend for an answer.

```text
Harm prevented: a YOLO turn stopping on an editor, nested-worker, direct-shell, or post-execute permission prompt after shell approval had already been disabled.
Scope and execution paths: root buildAgentTools, native apply_patch, conversation result building, continuation batches, SubagentToolFactory and nested editor policy, direct file/shell definitions, and the root post-execute pause capability.
Guard class: advisory approval gate; this removes false-positive permission prompts without removing tool execution/interceptor failures.
Enforcement owner: shouldBypassToolApproval plus the shared needsApproval wrapper, result builder, batch coordinator, and root tool factory.
Recovery owner: unchanged for genuine ask_user interactions, non-YOLO approvals, tool rejection results, sandbox/command failures, and lifecycle cancellation.
Measured signal and observation boundary: the effective shell.autoApproveMode value at each approval boundary and the exact tool name.
Direct evidence or proxy: centralized helper result and focused seam tests; no UI state is used as proof.
Legitimate work that can produce the old signal: any mutating editor, unsandboxed shell request, nested worker tool, or application post-execute gate while always mode is effective.
Configuration sources and precedence: ISettingsService effective shell.autoApproveMode; settings normalization still couples always mode to sandbox.enabled=false.
Effective default and clamping: unchanged; only exact always bypasses, and ask_user is always excluded.
Action and why the signal justifies it: return no approval requirement or policy approval in always mode, while preserving execution and interceptor paths.
Partial-work settlement: unchanged; tools execute or return their own structured failure, and ask_user remains resumable.
Retry, fallback, and provider-continuity semantics: unchanged.
Observability fields: YOLO bypasses emit approval.auto_approved debug/security evidence at the existing approval boundary; no new user-visible prompt is synthesized.
Persisted-setting migration, if any: none.
Rollback boundary: the shared helper and its callers, plus focused approval/editor/shell tests.
Ledger row: global YOLO approval bypass with ask_user exception.
```

Red proof before the shared production repair:

```text
NODE_ENV=test pnpm exec vitest run <focused approval/editor tests>
FAIL: native apply_patch, generic needsApproval wrapping, non-shell continuation policy,
      continuation batch, and conversation-result editor cases still prompted in always mode.
```

Detection gap: YOLO had been implemented as a shell/bash evaluator shortcut and
read-tool bypass. Mutating editor definitions, the native apply_patch override,
continuation policy, and nested worker wrappers each had independent approval
owners, so shell-focused coverage did not prove a global contract. The new tests
cover the shared wrapper, root and nested seams, the direct tool definitions,
both initial and continuation paths, the post-execute capability, and the
ask_user exception.

Verification:

```text
NODE_ENV=test pnpm exec vitest run <11 focused files>
PASS 11 files, 378 tests

pnpm typecheck
PASS

pnpm exec prettier --check <changed-files>
PASS

git diff --check
PASS

NODE_ENV=test pnpm test
PASS 496 files passed, 1 skipped; 6418 tests passed, 6 expected failures, 2 skipped
```

### PTY readiness-wait false timeout in the provider black-box harness

Disposition: **repaired locally on 2026-08-30; pending commit and merge.**

Incidents: 2026-08-27 SB-05 gate (one transient interactive public-hooks PTY
timeout, file passed 3/3 on rerun) and 2026-08-27 reasoning-length verification
(two full-suite attempts each failed a *different* 15s PTY wait while the child
sat healthy). Same class recurred on 2026-08-30: the full suite failed a
different 15s wait per attempt while the named scenario passed in isolation.

Root cause: the shared-runner policy from commit `886e1531` (one generous
ceiling, `--bail=1` bounds genuine hangs) was implemented in the harness's
`waitForState`/`waitForExit` but not everywhere waits are taken. The PTY
driver's `waitForIdleInput` forwarded `timeoutMs: undefined` into
`waitForHarnessIdleGeneration`, whose lib default is 15s — silently under the
harness's shared 40s ceiling. `public-hooks.blackbox.ts` pinned 15s literals on
all three interactive waits, and two sibling owners carried their own
duplicates: the responses fixture server's `waitForRequests` default 15s and
the resilience file's local `DEFAULT_TIMEOUT_MS = 7_500`. A control run with
the repair stashed reproduced the same `chaining` failure on the parent commit,
proving the gate failures were pre-existing contention, not the repair.

```text
Harm prevented: a healthy CLI startup under shared-runner contention failing a
  readiness wait that expires before the child can render.
Scope and execution paths: provider black-box PTY driver readiness waits (all
  blackbox scenarios) and scenario-file fixture waits; named incident is the
  public-hooks interactive startup.
Guard class: containment budget on a test readiness proxy; this is a
  false-positive repair (ceiling raised to the shared policy), not a
  protection weakening.
Enforcement owner: createPtyChild's waitForIdleInput (single point where the
  driver's shared timeout policy meets the idle channel) plus the exported
  DEFAULT_TIMEOUT_MS the scenario files now import for their fixture waits.
Recovery owner: the scenario (vitest failure with self-diagnosing error).
Measured signal and observation boundary: harness idle-generation file;
  child exit as terminal evidence.
Direct evidence or proxy: proxy (file generation). Justified: the file is the
  published composer-idle signal; first-run/menu ownership never publishes.
Legitimate work that can produce the same signal: slow PTY spawn, node boot,
  jiti hook load, Ink render under CPU contention (recorded in 886e1531).
Configuration sources and precedence: explicit timeoutMs argument > shared
  DEFAULT_TIMEOUT_MS (40s). CI bounds contention at the config level
  (maxWorkers 2) rather than by extending deadlines.
Effective default and clamping: none beyond the precedence above.
Action and why the signal justifies it: reject with an error naming the
  effective ceiling and the child's visible-output tail; fail fast when the
  child exits without publishing idle (a dead child can never satisfy the
  wait, so racing exit against idle shortens genuine-failure diagnosis).
Partial-work settlement: n/a (test-side guard); the child is settled by the
  existing afterEach/lease cleanup.
Retry, fallback, and provider-continuity semantics: n/a.
Observability fields: effective ceiling, elapsed wait, idle generation read,
  exit code/signal, visible-output tail — all in the thrown error.
Persisted-setting migration, if any: none.
Rollback boundary: provider-test-harness.ts + harness-input-idle.ts + the
  three scenario call-site files, one branch.
Ledger row: this section.
```

Red proof before the production change:

```text
NODE_ENV=test pnpm exec vitest run \
  source/lib/harness-input-idle.test.ts \
  scripts/provider-black-box/provider-test-harness.test.ts
FAIL 3 new tests: the lib timeout error named no effective ceiling; a bare
waitForIdleInput() rejected before the fake clock reached 40s (inherited 15s);
an exited child burned the full ceiling instead of failing fast.
PASS the 22 pre-existing tests (no behavior change claimed).
```

Detection gap: the shared-ceiling policy was recorded in a comment on one
constant and in a commit message, but nothing tied the idle lib's independent
15s default to it, and scenario files kept pinning per-call literals. The new
tests pin the driver default, the error content, and the exit-fast path.

Verification (2026-08-30):

```text
NODE_ENV=test pnpm exec vitest run \
  source/lib/harness-input-idle.test.ts \
  scripts/provider-black-box/provider-test-harness.test.ts
PASS 2 files, 25 tests (22 baseline + 3 new)

pnpm typecheck
PASS

pnpm exec prettier --check <changed-files>
PASS

CI=1 pnpm test:provider-black-box
PASS 19 files, 174 tests; 1 skipped (78s). Unconstrained local runs (8
workers on a shared 8-core container) still starve CLI children — the config
comment and the control run both identify that as contention, not a wait
failure — so the gate is validated under CI's worker bound.

NODE_ENV=test pnpm test
PASS 558 files; 1 skipped. 7135 tests; 3 expected fail, 2 skipped. Emitted the
existing TimeoutNaNWarning; no test failed.
```

### Retry/recovery containment budget and never-replay-after-committed-output precondition

Disposition: **repaired on branch `retry-recovery-contract`; seven commits,
pending merge to main.**

This entry covers a shared retry/recovery containment budget introduced on
this branch (an application-owned turn/tool-execution harness feature, not a
scan-discovered pre-existing guard) plus the safety precondition that gates
its one destructive action (replaying a full turn). Both were audited,
found to have four confirmed defects across two acceptance rounds, and
repaired with source-backed tests. Recorded here per this skill because the
guard shares the containment-budget class and the never-replay precondition
is exactly the "weak proxy interpreted as proof" failure mode this ledger
exists to catch.

Origin: the retry/recovery contract required (paraphrased from the task that
produced this branch) one shared 90-second / 3-physical-transport-attempt /
1-automatic-replay recovery envelope per logical turn, a rule that an
automatic replay must never happen once output has already been committed
to the user or a tool call has been dispatched, and truthful tool-execution
settlement on every termination path. The partial implementation audited at
the start of this branch got the budget's arithmetic right but scoped its
wiring to only the first model request of a turn, conflated an unrelated
pre-existing retry policy with the new budget, used a bare event-count/
array-length proxy for "committed output" that fired on internal bookkeeping
events, and skipped settlement on one termination path. All four are fixed
below.

```text
Harm prevented: an automatic transport-level retry/recovery loop (physical
  redispatch and full-history replay) running unbounded -- burning unlimited
  wall time or dispatch attempts on a wedged/misbehaving provider -- and,
  independently, an automatic replay duplicating already-delivered model
  output or re-triggering an already-dispatched tool call because the
  "was anything committed yet" check used a proxy broad enough to include
  bookkeeping-only signals.
Scope and execution paths: every provider request behind RetryingModel
  (source/providers/retrying-model.ts), for both the initial model request of
  a turn (InitialTurnRecoveryHandler) and every tool-call continuation request
  within the same logical turn (ContinuationRecoveryHandler). One recovery
  envelope per logical turn, shared across root turns and subagents -- both
  drive through the same TurnWorkflow/TurnAttempt/AgentClient path; there is
  no separate subagent owner.
Guard class: containment budget (wall time / physical-attempt count / replay
  count), gated by an admission-style evidence check (never-replay-after-
  committed-output) that must pass before the budget's one destructive action
  (automatic full-history replay) is allowed to fire.
Enforcement owner: RetryRecoveryBudget (source/services/retry/
  retry-recovery-budget.ts) is the sole budget instance/owner for a logical
  turn. InitialTurnRecoveryHandler and ContinuationRecoveryHandler claim one
  physical attempt (claimPhysicalAttempt()) when they execute a retry_fresh
  recovery plan. RetryingModel.stream() claims additional physical attempts
  only for its own post-failure backoff-retry loop; the first dispatch and
  successful tool-call continuations are ordinary work and do not consume the
  recovery allowance. Both recovery handlers also claim the single automatic
  replay (claimAutomaticReplay()) before executing a retry_fresh recovery plan, and
  start the 90s clock lazily (noteRetryableFailure(), on first retryable
  failure, not at turn start) for transient/chain_recovery classifications
  only. One RetryRecoveryBudget instance is shared for the whole logical
  turn: created per TurnAttempt (turn-attempt.ts), threaded to
  AgentClientRunOptions.recoveryBudget for the initial request, and threaded
  to ContinuationState.recoveryBudget for every continuation attempt driven
  within the same turn via TurnWorkflow.#activeRecoveryBudget (set wherever
  executeInitialAttempt resolves a TurnAttempt).
Recovery owner: DefaultRecoveryExecutor.apply() (source/services/retry/
  recovery-executor.ts) performs actual settlement on termination
  (toolTracker.settleOpenCallsOnStreamFailure -- dispatched calls settle as
  unknown, not failed; markOpenCallsAborted; providerContinuity.clear() so
  the next turn cannot send a text-only continuation against a response
  still awaiting tool output). Both recovery handlers call this before
  returning terminated, including on budget refusal (fixed this branch,
  `28a18aab` -- see confirmed defect 4 below).
Measured signal and observation boundary: physical attempts -- dispatch
  count to the provider's stream(), observed inside RetryingModel.stream()'s
  retry loop. Wall time -- elapsed since the first retryable failure,
  performance.now() (injectable). Automatic replays -- count of retry_fresh
  plans actually executed, claimed before recoveryExecutor.apply() runs the
  plan. Committed-output precondition -- two projections of the same
  underlying signal: TurnAttempt.modelEventSeen (session ConversationEvents
  emitted by TurnWorkflow.#consumeInitialStream, filtered through
  isCommittedOutputEvent) for the initial-request path, and
  streamHasCommittedOutput(stream) (raw ApplicationRunEvent[] in
  stream.output/stream.newItems) checked by retry-classifier.ts for both
  paths.
Direct evidence or proxy: proxy for all three budget dimensions -- none
  measures "will one more attempt help," only accumulated cost. Justified
  because the alternative (no bound) risks unbounded burn on a wedged
  provider. The committed-output precondition is also a proxy (event-type
  membership in a bookkeeping-only set standing in for "was anything
  actually delivered or dispatched") -- the exact class this ledger audits,
  and the subject of confirmed defects 3 and 4 below.
Legitimate work that can produce the same signal: a slow provider needing
  several genuine transient retries within 90s (budget arithmetic covered by
  retry-recovery-budget.test.ts, not separately re-verified this round).
  model_retry (hallucination/parsing/behavior detection) is a distinct,
  pre-existing, independently-capped retry mechanism (maxModelRetries) that
  legitimately needs multiple replay attempts within one turn -- confirmed
  regression, defect 2. A cost_update ConversationEvent fires even for a
  request that produced nothing (outcome: 'failed') -- confirmed regression,
  defect 3. run_budget evidence, the three context_compaction_* lifecycle
  events, and codex_rate_limits are pushed unconditionally into
  stream.output/stream.newItems by outputPush() in
  application-run-loop.ts, independent of whether the request produced
  anything -- confirmed regression, defect 4 (this acceptance round).
Genuine harmful case that must still trip the guard: real streamed
  text/reasoning, a committed provider item (assistant message, tool result,
  provider-opaque item), or a dispatched-but-unresolved tool call in the
  stream all still correctly force unrecoverable / refuse the replay --
  proven by the paired true-positive case next to every false-positive test
  added this round (retry-classifier.test.ts, continuation-recovery-
  handler.test.ts, agent-stream.test.ts).
Configuration sources and precedence: no user-facing setting.
  RETRY_RECOVERY_LIMITS (retry-recovery-budget.ts) declares fixed constants
  (maxRecoveryTimeMs 90_000, maxPhysicalAttempts 3, maxAutomaticReplays 1).
  RetryRecoveryBudgetOptions accepts constructor overrides but no production
  call site supplies them -- every real construction (TurnAttempt's default,
  ContinuationState's default) uses the class defaults; overrides exist only
  for tests. maxPhysicalAttempts(3) is a second, independent cap layered on
  top of the pre-existing agent.retryAttempts setting consumed by
  RetryingModel's own retry-count option: even a user-configured
  retryAttempts higher than 3 cannot push total physical dispatches for one
  logical turn past 3, because every dispatch through RetryingModel.stream()
  -- across the session layer's retry_fresh/replay_turn redispatches and
  RetryingModel's own internal backoff loop alike -- claims against the same
  shared instance.
Effective default and clamping: 90,000ms wall time (clock starts lazily on
  first retryable failure), 3 physical transport attempts, 1 automatic
  full-history replay -- fixed, not configurable, no min/max clamping beyond
  the literal constants.
Action and why the signal justifies it: claimPhysicalAttempt() returning
  false -> RetryingModel throws the typed RetryRecoveryBudgetExhaustedError
  (carries the triggering failure as `cause`) instead of dispatching another
  physical attempt. claimAutomaticReplay() returning false -> the recovery
  handler refuses the retry_fresh plan, settles the turn through
  recoveryExecutor.apply({kind:'terminate'}), and emits a typed
  retry_exhausted ConversationEvent. Both are "reject before start"
  (admission-limit-shaped); an in-flight physical dispatch or an in-flight
  tool call is never aborted by this guard.
Partial-work settlement: recoveryExecutor.apply({kind:'terminate'}) settles
  open tool calls truthfully and clears provider continuity (see Recovery
  owner). Confirmed defect 4a below: this was skipped entirely on the
  budget-refusal path before this branch.
Retry, fallback, and provider-continuity semantics:
  RetryRecoveryBudgetExhaustedError is recognized by retry-classifier.ts as
  terminal (isRetryRecoveryBudgetExhaustedError check) so a still-armed
  session-level classifier does not re-enter RetryingModel against the same
  exhausted budget and bounce between layers. model_retry-classified
  failures are excluded from both noteRetryableFailure() and
  claimAutomaticReplay() so they retry independently up to their own
  maxModelRetries -- but each model_retry-driven replay_turn redispatch
  does not consume a physical-attempt claim: model_retry is excluded from the
  transport-recovery envelope and remains bounded by its own maxModelRetries.
Observability fields: retry_exhausted ConversationEvent carries provider,
  errorKind, attempts, maxAttempts, message, canRetry.
  provider.response.failed structured evidence (via classifyProviderFailure)
  carries errorKind, code, status, retryAfterMs, retryable, and a sanitized
  message (no raw stack, no secrets) -- logged through
  ProviderTraffic.recordRequestFailed and AgentClient's stream-failure
  logger.
Persisted-setting migration, if any: none -- no setting exists for this
  guard.
Rollback boundary: branch `retry-recovery-contract` is the outer rollback
  unit. Within it, each of the seven commits below targets one named defect
  with its own tests and is independently revertible.
Ledger row: this section.
```

Four confirmed defects, in commit order:

**1. `a00a899f` -- typed budget-exhaustion error dropped, classifier could
bounce between layers.** RetryingModel raised a bare `new Error(...)` on
`claimPhysicalAttempt()` refusal instead of the dedicated
`RetryRecoveryBudgetExhaustedError`, discarding the triggering failure's
`cause` chain and classifying as non-retryable "unknown" through
`classifyProviderFailure` -- which meant the `exhausted` flag driving the
`retry_exhausted` UI event evaluated false for exactly the case it exists to
catch, and nothing stopped the session-level classifier from issuing another
retry that re-enters RetryingModel, reclaims against the same exhausted
budget, and throws the same error again.

**2. `66abfcec` -- model_retry silently capped at 1 by the transport
budget.** Both recovery handlers charged every `retry_fresh` *and* every
`replay_turn` plan against the shared 1-automatic-replay allowance.
`replay_turn` is produced exclusively by `model_retry`
(hallucination/parsing/behavior detection), a distinct pre-existing retry
policy independently capped at `maxModelRetries` (tested elsewhere at 2).
Folding it into the transport budget's single replay slot silently cut an
established, separately-tested retry count in half. Bisected to a real
regression: `conversation-service.test.ts`'s "stops retrying after max
hallucination retries" test (expects 3 attempts: initial + 2 retries)
returned 2 attempts when run against this branch's foundation commit
(`c66e0ac4`) in an isolated worktree; the test predates this branch, so its
own assertion (3 attempts) is itself the record of pre-regression behavior.

**3. `839d2781` -- `cost_update` masquerading as committed output.**
`TurnAttempt.markModelEventSeen()` fired for every `ConversationEvent` the
initial stream emitted, with no filter. `cost_update` fires even for a
request that produced nothing at all (its own `outcome` field can be
`'failed'`), so a request that failed before streaming a single token still
set `hasCommittedOutput = true`, forcing `retry-classifier.ts` to return
`'unrecoverable'` regardless of the real classification -- silently
disabling chain_recovery/transient/model_retry recovery for the ordinary
case of "the first physical attempt failed immediately." Bisected to a real
regression: `subagent-manager.retry.test.ts` (8/8 passing at the true
pre-branch base `22ca9764`) dropped to 4/8 at this branch's foundation
commit `c66e0ac4` in an isolated worktree; traced live with temporary
instrumentation to the exact event
`{"type":"cost_update","record":{...,"outcome":"failed"}}` with
`stream.output`/`stream.newItems` both confirmed empty at the point the
guard fired. Fixed with `isCommittedOutputEvent()`
(conversation-events.ts), excluding known bookkeeping/telemetry
ConversationEvent kinds.

**4. `28a18aab` -- truthful settlement skipped on budget-refusal
termination.** When the automatic-replay budget refused a `retry_fresh`
plan, both handlers returned `{kind:'terminated'}` directly without ever
calling `recoveryExecutor.apply()` -- skipping `settleOpenCallsOnStreamFailure`/
`markOpenCallsAborted` (open tool calls never settled truthfully) and
`providerContinuity.clear()` (the next turn could send a text-only
continuation against a response still awaiting tool output). Every other
termination path in both handlers already went through this call; this one
early-returned around it. The pattern predates this branch's fixes -- it was
already present in the foundation commit's original
`plan.kind === 'retry_fresh' || plan.kind === 'replay_turn'` gate -- and
commits `a00a899f`/`3d9dab32`/`66abfcec` all narrowed that gate's condition
without closing this settlement gap.

**Follow-up closed this acceptance round -- `a7e44292`, requirement-5
raw-array false positive.** Defect 3 above closed the gap only on the
session-layer `ConversationEvent` stream consumed by
`InitialTurnRecoveryHandler`. `retry-classifier.ts`'s guard *also* checks
`stream.output`/`stream.newItems` directly -- a raw `ApplicationRunEvent[]`
array, the only signal `ContinuationRecoveryHandler` has (it never passes
`hasCommittedOutput`) -- via a bare `.length > 0` check left as a known,
unresolved risk in the prior acceptance receipt.

Traced every `outputPush()` call site in `application-run-loop.ts` (16
total, exhaustively) to enumerate every `ApplicationRunEvent` type that can
reach `stream.output`/`stream.newItems`: `text_delta`, `reasoning_delta`,
`tool_call_streaming_delta`, `item` (assistant text, tool calls, reasoning,
provider-opaque items), `tool_call_dispatched`, `codex_rate_limits`, the
three `context_compaction_*` lifecycle events, and `run_budget`. Of these,
`run_budget` and `context_compaction_*` are pushed unconditionally as soon
as they occur (independent of request outcome), and `codex_rate_limits` is
quota metadata -- none carry committed model output or an externally
effectful action. Confirmed `usage_update`, `cost_update`,
`subagent_run_budget`, and `background_check_in_due` can never appear in
these arrays: `usage_update` goes straight to the event queue via
`queue.push` (never `outputPush`), and the other three are synthesized only
at the session layer above this raw array.

Fix: `streamHasCommittedOutput()` (source/services/agent-stream.ts), the
raw-array counterpart to `isCommittedOutputEvent`, replaces the bare length
check in `retry-classifier.ts`.

Red proof before the production change (temporarily reverted
`agent-stream.ts` and `retry-classifier.ts` to their pre-fix state, kept the
new tests, confirmed failure, then restored -- diff was empty after
restoring, confirming an exact revert):

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-stream.test.ts \
  source/services/retry/retry-classifier.test.ts \
  source/services/session/continuation-recovery-handler.test.ts
FAIL 7 tests:
  agent-stream.test.ts: 5 failed with "streamHasCommittedOutput is not a
    function" (function did not exist pre-fix).
  retry-classifier.test.ts > "classify still recovers a transient failure
    when the stream carries only bookkeeping evidence": expected
    'transient', received 'unrecoverable'.
  continuation-recovery-handler.test.ts > "recovers a mid-continuation
    transient failure through the real classifier when the stream carries
    only bookkeeping evidence": expected 'resume', received 'terminated'.
PASS the 50 other tests in those 3 files unaffected (baseline unchanged).
```

Detection gap: defect 3's fix and tests covered only the ConversationEvent
projection; nothing asserted the raw-array path used by the continuation
handler, so the identical false-positive shape survived one full audit round
undetected in the code the audit itself had just written.

Focused verification (this acceptance round):

```text
NODE_ENV=test pnpm exec vitest run \
  source/services/agent-stream.test.ts \
  source/services/retry/retry-classifier.test.ts \
  source/services/session/continuation-recovery-handler.test.ts \
  source/services/session/initial-turn-recovery-handler.test.ts \
  source/providers/retrying-model.test.ts \
  source/services/subagents/subagent-manager.retry.test.ts \
  source/services/conversation/conversation-service.test.ts \
  source/services/conversation/conversation-events.test.ts
PASS 8 files, 136 tests

pnpm typecheck
PASS

NODE_ENV=test pnpm exec vitest run source/
PASS 554 files (1 skipped), 7121 tests, 3 expected fail, 2 skipped

pnpm test:provider-black-box
PASS 19 files, 174 tests, 1 skipped
```

Final commit IDs (branch `retry-recovery-contract`, base `22ca9764`, merged
main `30bf34f9` -> `14fc8198`):

```text
c66e0ac4  feat(retry): land retry/recovery contract foundation
a00a899f  fix(retry): raise typed budget-exhaustion error and stop the classifier bounce
3d9dab32  fix(retry): share the recovery budget with continuation attempts
839d2781  fix(retry): stop cost_update from masquerading as committed model output
66abfcec  fix(retry): stop model_retry from drawing on the transport recovery budget
e353680f  fix(retry): wire retry_exhausted to a real retry, not literal button text
28a18aab  fix(retry): settle the turn truthfully when refusing a plan for exhausted replay budget
30bf34f9  Merge main into retry-recovery-contract
a7e44292  fix(retry): close the requirement-5 raw-array false-positive risk
```

### Codex WebSocket connect-time timeout recovery

Disposition: **repaired in `4f4ba2a0`; documented in `ad2e247f`; merged in `640a1e37`.**

Live request `d066fb9e` exposed a gap in the Codex WebSocket recovery
boundary: the initial subagent request failed during socket connection with
`ETIMEDOUT`, no raw frames arrived, and the send path had positively recorded
the request as `unsent`. The adapter nevertheless wrapped the error as
`AmbiguousModelOutcomeError`, so retry classification terminated the session
instead of taking the one safe full-history recovery. This repair preserves the
fail-closed behavior for `flushed` and `unknown` dispatch evidence.

```text
Harm prevented: a request proven never to have reached the provider being
  terminated instead of receiving its single bounded full-history recovery.
Scope and execution paths: Codex Responses WebSocket initial model requests,
  including sessions whose fresh-start retries are disabled (subagents).
Guard class: inactivity watchdog / transport recovery, gated by dispatch
  evidence.
Enforcement owner: CodexResponsesWSModel and websocket-request-dispatch state.
Recovery owner: DefaultRetryClassifier and InitialTurnRecoveryHandler.
Measured signal and observation boundary: no raw WebSocket frame was observed,
  the connect-time failure carries a structured ETIMEDOUT code, and the exact
  request object is positively recorded as unsent by the send path.
Direct evidence or proxy: dispatch state and frame count are direct evidence;
  ETIMEDOUT identifies the connect-time transport failure.
Legitimate work that can produce the same signal: a frame flushed to an open
  socket, or a send path that cannot observe its state; both remain ambiguous.
Configuration sources and precedence: existing websocket first/inter-frame
  watchdog settings; no default or precedence change.
Effective default and clamping: shared recovery envelope remains 90s / 3
  physical attempts / 1 automatic replay.
Action and why the signal justifies it: convert only the positively unsent,
  frame-free connect timeout to UnsentWebSocketRequestError, classify it as
  chain_recovery, and rebuild full history once. This path does not replay the
  possibly accepted request or re-run a tool call.
Partial-work settlement: unchanged; recovery termination still settles open
  tool calls truthfully and clears provider continuity.
Retry, fallback, and provider-continuity semantics: flushed or unknown dispatch
  remains AmbiguousModelOutcomeError and terminates; no recovery occurs after a
  committed frame/output. Existing shared recovery limits remain authoritative.
Observability fields: existing Codex failed-request traffic record and bounded
  watchdog timing; no payload or credential changes.
Persisted-setting migration, if any: none.
Rollback boundary: the repair commit listed below.
Ledger row: Codex WebSocket watchdog.
```

Red proof before production changes:

```text
NODE_ENV=test pnpm exec vitest run source/services/session/initial-turn-recovery-handler.test.ts -t "connect-time ETIMEDOUT"
FAIL: positive `unsent` evidence was wrapped as AmbiguousModelOutcomeError;
      the subagent-style session terminated instead of scheduling full-history
      recovery. The `flushed` and `unknown` counterparts remained terminated.
```

Detection gap: the existing watchdog tests covered watchdog-generated timeout
errors and dispatch states, but not a connect-time error emitted before the
watchdog itself expired. The adapter's error wrapping therefore erased the
positive dispatch evidence at exactly the boundary where the subagent policy
needed to distinguish safe full-history recovery from a fresh-start replay.
The regression now spans the real Codex adapter, the typed dispatch evidence,
the classifier, and the fresh-start-disabled initial recovery owner, with
flushed/unknown fail-closed counterparts.

Verification (this branch):

```text
NODE_ENV=test pnpm exec vitest run source/services/session/initial-turn-recovery-handler.test.ts \
  source/services/retry/retry-classifier.test.ts \
  source/providers/codex-responses-model.test.ts \
  source/providers/websocket-request-dispatch.test.ts
PASS 4 files, 146 tests

pnpm test:related ./source/providers/codex-responses-model.ts \
  ./source/services/retry/retry-classifier.ts
KNOWN BASELINE FAILURE: 156 files passed; 6 unrelated file-boundary safety
  assertions failed in apply-patch.test.ts, create-file.test.ts, and
  search-replace.test.ts.

pnpm typecheck
PASS

git diff --check && pnpm exec prettier --check \
  source/providers/codex-responses-model.ts \
  source/services/retry/retry-classifier.ts \
  source/services/retry/retry-classifier.test.ts \
  source/services/session/initial-turn-recovery-handler.test.ts \
  docs/plans/guard-ledger.md
PASS

pnpm test:provider-black-box
PASS 19 files, 174 tests; 1 skipped
```

Final implementation commit: `4f4ba2a0`.

## Reference: catalogued guards

Recorded so the next reader does not re-derive them. **No row here owes a test.**
Read the relevant row before changing its owner; promote one to a candidate only
when an incident or a source-level contradiction justifies it.

Owned by other plans — do not repair independently:

| Guard | Value | Owner |
| --- | --- | --- |
| Interactive / runtime / role `maxTurns` | `agent.maxTurns=100`; AgentRuntime fallback `20`; roles 200 or 1 | run-budget-stall-escalation |
| `ExecutionBudget.maxTokens` | opt-in; aborts the shared tree | run-budget-stall-escalation |
| Identical tool failure evidence | third identical `(tool,args,error)` gets advisory text; cumulative, not consecutive; does not block execution | run-budget-stall-escalation |
| Context compaction thresholds | ratio 0.8; optional raw-token threshold | provider-neutral-compaction |
| Provider stream contract throws | `ai-sdk-streamed-model.ts`, `openai-responses-model.ts`, `codex-turn-converter.ts`, etc. | tool-output-and-effect-safety, chain-settlement |

Catalogued, no hypothesized failure mode:

| Guard | Effective value | Configurable |
| --- | --- | --- |
| Provider `maxOutputTokens` | 32,000, clamped to catalog | yes |
| Retry attempts | `agent.retryAttempts=2` | yes |
| Async subagent retention | 30m completed TTL (`subagent.asyncSessionTtlMs`); 50 retained user turns | TTL only |
| `AgentDefinition.limits.timeoutMs` | undefined; `AbortSignal.timeout` via `executor.ts:36,39` — the only inline deadline in `source/` | opt-in |
| `ExecutionBudget.maxChildren/maxDepth/maxConcurrency` | opt-in | opt-in |
| Agent workflow timeout / run / concurrency / code / output / console | 120s / 8 / 3 / 16KiB / 64KiB / 16KiB | no |
| Shell context output | 1000 lines / 40k chars | no |
| `boundToolResultText` | 40k UTF-8 bytes, spools artifact + path (`verified safe`) | no |
| Hook callback timeout | 5s | no |
| Patch/edit healing timeout and file-size cap | helper defaults | no |
| Web fetch character cap | 10k default, 200k max, with continuation | yes |
| Subagent continuation segments | 3 | injectable |
| Subagent question length | 1200 chars; throws | no |
| Async steering guidance length | 2000 chars; rejected | no |
| Async run turn history | 5 turns / 200 chars (progress snapshot only) | no |
| App log retention | 7 days | no |
| OpenCode transport discovery cache | 24h successful endpoint-table snapshot; a 2s failed or invalid lookup falls back to local Chat routing | no |
| Active-turn cancel wait | 10,000 ms | injectable |
| Shell auto-approval evidence caps | 8 / 3000 / 500 / 10 / 1000 / 20 | no |
| Tool argument repair caps | 200,000 / 8 / 2048 / 160 / 16 | no |
| Code-context search bounds | 512KiB / 10,000 files / 20 results | `max_results` |
| Background shell watch match text | 4096 chars / 1500 ms idle | watch options |
| Turns-left advisory | threshold 5 | no |
| Terminal result exhaustion | typed `TerminalResultCollectorExhaustionError extends AmbiguousModelOutcomeError`; preserves `unsafeToReplay` and local-vs-provider provenance | no |
| Codex WebSocket watchdog | 90s to first raw event, 600s between; a first-frame expiry recovers as `retry_fresh`/`full_history` only when the send path recorded the frame as provably `unsent`, otherwise it stays ambiguous and terminates; reports measured latencies and its budgets to the traffic log | `agent.codex.websocketFirstFrameTimeoutMs` / `…InterFrameTimeoutMs` |
| Queue/background registry capacity | owner-specific | varies |

"Injectable" means a constructor or deps field exists but no settings key feeds
it. Apart from the `maxParallelToolCalls` defect, **none** of the guards found by
discovery is user-configurable — they are hardcoded constants with at most a
test-injection seam.

## Reference: excluded leads

Why these cannot affect agent execution, model context, persistence, or recovery.

### Logging and diagnostic rendering

| Location | Constant | Evidence |
| --- | --- | --- |
| `utils/output/log-truncation.ts` | `MAX_IMAGE_DATA_LEN`, `MAX_SYSTEM_PROMPT_LEN`, `MAX_TOOL_DESC_LEN`, `MAX_TOOL_CALL_LEN`, `MAX_TOOL_OUTPUT_LEN`, `MAX_LOG_TEXT_LEN` | Applied when formatting app-log records; never read back into model context or replay. |
| `services/logging/provider-traffic.ts` | `TRAFFIC_TEXT_LIMIT=100`, `PREVIEW_LIMIT=160` | Bounds a preview stored beside the frame; the untruncated frame is still written. |
| `utils/ai/provider-traffic-extractor.ts` | `TRUNCATE_LEN=120` | Diagnostic summary string; no caller feeds it to a provider. |
| `providers/codex-responses-model.ts` | `SUSPICIOUS_RECONSTRUCTED_OUTPUT_ITEM_COUNT=20` | Warn-only; logs and does not reject, truncate, or abort. |

### UI presentation, debounce, and input timing

| Location | Constant | Evidence |
| --- | --- | --- |
| `hooks/use-debounced-value.ts` | debounce timer | Delays a rendered value; no execution path observes it. |
| `hooks/use-terminal-width.ts` | resize debounce | Recomputes layout width. |
| `hooks/use-escape-key.ts` | double-Escape window | Distinguishes single from double Escape; cancellation is owned elsewhere. |
| `hooks/use-app-keyboard-shortcuts.ts` | interrupt timer | How long the interrupt hint stays visible. |
| `services/conversation/conversation-orchestrator.ts` | `REASONING_RESPONSE_THROTTLE_MS=200` | Throttles re-render; the stream is unmodified. |
| `utils/clipboard.ts` | `OSC52_MAX_BYTES` | Bounds a terminal clipboard escape sequence. |
| `utils/output/tty-osc.ts` | `CHUNK_SIZE=768` | Splits an escape sequence for transport; lossless. |
| `utils/value-suggestions.ts`, `hooks/use-path-completion.ts` | `MAX_RESULTS=10` | Bounds a completion menu; surfaced to the user, consumed by no tool. |
| `services/subagents/utils.ts`, `tools/agent/run-subagent.ts` | `MAX_PREVIEW_LENGTH=300` | Panel display preview; full task text retained on the run. |

### Non-guard numeric constants

| Location | Constant | Evidence |
| --- | --- | --- |
| `providers/model-catalog/catalog.ts` | `TIER_*` weights | Model-name match scoring; orders candidates, rejects nothing. |
| `providers/codex.provider.ts` | `ONE_DAY_MS` | Token-expiry display arithmetic. |
| `utils/shell/test-fixtures/orphan-holder.mjs` | `HOLD_MS=60_000` | Test fixture process, never loaded by the app. |

### Tool-local validation and persistence failures

`services/memory/memory-store.ts` throws `InvalidMemoryError` (argument
validation before any write) and `MemoryStorageError` (filesystem and
index-corruption). The only consumer is `tools/memory/memory-tools.ts`, so both
settle as a tool failure and cannot terminate a run.

### Typed admission rejections

`services/subagents/subagent-async-registry.ts` throws `SubagentRegistryError`
with a closed `code` union — `not_continuable`, `invalid_name`, `name_in_use`,
`not_found`, `evicted`, `role_mismatch`, `already_active`, `worker_blocked`.
Every site fires during admission, before a session is created or resumed, and
none touches a running run. Two notes retained: `evicted` is deliberately
distinct from `not_found` and should stay that way if TTL eviction changes; and
capacity release on failure and cancellation is untested.

### Throw-site classification

All 260 non-test `throw new` sites in `source/services`, `source/providers`,
`source/utils/shell`, and `source/lib` were traced. **None terminates admitted
work outside the guards above.**

| Category | Representative sites | Why excluded |
| --- | --- | --- |
| Constructor and option validation | `background-shell-registry.ts:166,169`, `background-shell-output-store.ts:105-220`, `background-shell-watches.ts:190-196`, `hook-registry.ts:84`, `context-compaction/index.ts:24,32` | Thrown during construction, before work is admitted. |
| Settings load and mutation | `settings-service.ts:164-689` | Rejects an invalid or restart-only change; no run in flight at the owner. |
| Provider configuration and discovery | `openai-compatible.provider.ts:305-360`, `openai-compatible-lazy.ts:19-44`, `codex.provider.ts:133-605`, `registry.ts:80`, `model-service.ts:40` | Fails a setup or catalog request, not an executing turn. |
| Lifecycle and state-machine invariants | `turn-status-machine.ts:56,125`, `turn-coordinator.ts:53-143`, `foreground-subagent-lease.ts:106-166`, `post-execute-pending-registry.ts:106,108`, `hook-registry.ts:115-181`, `subagent-run-control.ts:96,149-152` | Programming-error guards for impossible transitions. |
| Capability and mode restrictions | `subagent-bridge.ts:278-436`, `execution-context.ts:57-80`, `editor-impl.ts:32`, `docker-host-control.ts:164-175`, `role-loader.ts:91` | Authority boundaries; reject a request rather than terminate work. |
| Programmer-error helpers | `upstream-retry-policy.ts:177`, `agent-stream.ts:78`, `hook-module-loader.ts:72` | Unreachable without a caller bug. |

Two cosmetic issues, not inventoried: `memory-store.ts:427` throws a bare
`new Error()` used as locally-caught control flow, and
`background-shell-registry.ts:209,283,286` throw untyped `Error` for lease
invariants while the same file uses typed errors elsewhere.

### Discovery caveats

Recorded so nobody claims completeness the sweeps did not deliver:

1. Discovery covered `source/`. Two eval scripts under `scripts/` appeared and
   were not traced; they are not shipped in the agent runtime.
2. The searches find named constants, throws, and a keyword set. **A guard
   written as an inline comparison against a literal inside a larger expression
   would not be caught by any of them.**
3. `verified safe` was assigned to exactly one row, and it arrived with that
   status. Nothing was promoted without tests.

The sweeps, for the record:

```bash
rg -n 'throw new|\.abort\(|\.kill\(|SIGKILL|SIGTERM' source
rg -n 'timeout|deadline|maxTurns|max[A-Z].*(Tokens|Chars|Bytes|Duration|Retries|Runs|Children|Depth|Concurrency)' source
rg -n 'capacity|retention|TTL|expires|evict|overflow|truncate' source
rg -n 'unsafeToReplay|retryable|transient|transportFallback|cancelled|timed_out' source/services source/providers
rg -n 'Guard|Watchdog|action: .(block|reject)|\b(block|reject|drop|discard)\b' source
```

## Verification

Focused owner tests plus `pnpm typecheck` for each repair. Additionally:

```bash
pnpm exec prettier --check <changed-files>
NODE_ENV=test pnpm test
pnpm test:provider-black-box   # any provider, bridge, run-loop, registry, or non-interactive change
```

Report focused success separately from baseline, environment, or sandbox-only
failures. Never call a guard safe solely because its termination test passes.

## Done when

1. The `maxParallelToolCalls` repair is approved and merged, or explicitly
   declined and recorded here.
2. Each of the five candidates is either repaired with a red-proof test and an
   independently revertible commit, or downgraded with evidence.
3. Every destructive repair preserves truthful partial-work settlement.
4. Provider and run-loop changes pass the black-box gate.
5. This document records the final dispositions and commit IDs, then moves to the
   completed list in `AGENTS.md`.

The reference tables above do not gate completion.
