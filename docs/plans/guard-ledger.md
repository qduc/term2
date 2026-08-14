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
- **In progress:** tool ownership lifecycle repair is implemented and undergoing
  final verification on branch `guard-tool-ownership`.
- **Next:** implement the remaining two approved repairs in separate worktrees
  and independently revertible commits. Re-run each recorded red proof first
  and follow the verification gates below.

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

Disposition: **implemented on branch `guard-tool-ownership`; merge pending.**
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
| Active-turn cancel wait | 10,000 ms | injectable |
| Shell auto-approval evidence caps | 8 / 3000 / 500 / 10 / 1000 / 20 | no |
| Tool argument repair caps | 200,000 / 8 / 2048 / 160 / 16 | no |
| Code-context search bounds | 512KiB / 10,000 files / 20 results | `max_results` |
| Background shell watch match text | 4096 chars / 1500 ms idle | watch options |
| Turns-left advisory | threshold 5 | no |
| Terminal result exhaustion | typed `TerminalResultCollectorExhaustionError extends AmbiguousModelOutcomeError`; preserves `unsafeToReplay` and local-vs-provider provenance | no |
| Codex WebSocket watchdog | 90s to first raw event, 600s between; retryable abort with HTTP fallback | no |
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
