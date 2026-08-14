# Term2 Guard Ledger and Remediation Plan

Status: **ready to implement, starting at Work Package 0.** No runtime behavior
change is authorized merely because a guard is listed here. A guard moves into a
repair package only after a red-capable characterization test proves a false
positive or a source-level contradiction proves that its signal cannot justify
its action.

## Goal

Find every harness guard that can reject, truncate, abort, kill, evict, or settle
work; record the complete path from configuration to recovery; and repair guards
whose proxy signal can destroy legitimate work.

The governing rule is:

> The harness may measure and contain work. It must not silently interpret a
> weak proxy as proof that productive work is invalid.

This plan inventories guard behavior. Budget judgment for turns, time, cost, and
stall evidence remains owned by
[`run-budget-stall-escalation.md`](./run-budget-stall-escalation.md). Shell
execution and retention changes must preserve the decisions in
[`background-shell-monitor/MAP.md`](./background-shell-monitor/MAP.md). Provider
or run-loop changes require the provider black-box suite.

## Resume here

Begin with **WP0: Complete the inventory**. Do not start by changing defaults.

The first two commits change no runtime behavior. WP0 is documentation-only;
WP1 adds characterization tests and fixtures only:

1. mechanically enumerate enforcement sites;
2. classify each site using the guard classes below;
3. add missing rows to the inventory and an exclusion appendix;
4. establish focused red-capable tests for the high-risk candidates in WP1.

At the WP1 gate, present the evidence to the user. Only entries marked
`confirmed defect` proceed to behavior changes. Each behavior change gets its
own worktree and commit so it can be reviewed and reverted independently.

## Scope

Included:

- limits and watchdogs that can terminate active work;
- admission limits that can prevent requested work from starting;
- truncation or eviction that can hide information needed to continue work;
- retry/recovery classification that can turn a recoverable event into a final
  failure;
- default, environment, persisted, role, parent, and per-invocation values that
  determine the effective limit.

Excluded, but recorded in the exclusion appendix:

- test-harness deadlines;
- UI debounce, animation, and presentation limits;
- logging-only truncation when it cannot affect replay or model context;
- persistence lock deadlines that cannot terminate an agent turn;
- security boundaries whose purpose is authority restriction rather than work
  duration, unless their failure handling destroys unrelated work.

## Guard model

Every included guard is traced through this lifecycle:

```text
Setting/default -> measured signal -> enforcement action -> recovery classification
```

Each inventory row must also record effective-value resolution and evidence:

```text
schema/default -> role/parent clamp -> runtime override -> per-call override
              -> effective value -> observed trip -> final settlement
```

### Guard classes

| Class | Examples | Correct contract |
| --- | --- | --- |
| Inactivity watchdog | WebSocket first/inter-frame silence | Reset only on activity that proves the watched transport is alive; expire into a typed, recoverable transport failure. |
| Containment budget | wall time, cost, turns, workflow runtime | Progress is evidence, not an automatic unlimited extension. Warn or escalate before destructive settlement where the owner design permits it. |
| Admission limit | child count, depth, concurrency, workflow run count | Reject before starting new work; never abort unrelated admitted work. |
| Context/loss bound | tool result bytes, retained messages | Preserve or make the omitted material retrievable and tell the consumer exactly what happened. |
| Runaway detector | repeated model output, identical failures | Require evidence specific to the runaway class; do not equate ordinary repetition with a loop. |
| Advisory guard | repeated-failure guidance | May steer behavior, but must not fabricate execution failure or become stale after the evidence is invalidated. |

There is deliberately no universal rule that “visible progress disables a
limit.” A noisy infinite process is still infinite. Progress resets an
*inactivity* detector; for a containment budget it is evidence supplied to the
judge described by the run-budget plan.

### Status vocabulary

| Status | Meaning |
| --- | --- |
| `uncharacterized` | Source location is known, but the effective value or failure path is not fully proven. |
| `candidate` | A concrete false-positive scenario exists but has not yet gone red. |
| `confirmed defect` | A deterministic test or captured trace reproduces legitimate work being harmed. |
| `verified safe` | Tests prove the guard preserves work or fails through the intended recoverable path. |
| `dependency` | Remediation belongs to another approved design and must not be implemented independently here. |

## Completion standard for the inventory

WP0 is complete only when all results from these searches are either present in
the inventory or named in the exclusion appendix:

```bash
rg -n 'throw new|\.abort\(|\.kill\(|SIGKILL|SIGTERM' source
rg -n 'timeout|deadline|maxTurns|max[A-Z].*(Tokens|Chars|Bytes|Duration|Retries|Runs|Children|Depth|Concurrency)' source
rg -n 'capacity|retention|TTL|expires|evict|overflow|truncate' source
rg -n 'unsafeToReplay|retryable|transient|transportFallback|cancelled|timed_out' source/services source/providers
rg -n 'Guard|Watchdog|action: .(block|reject)|\b(block|reject|drop|discard)\b' source
```

Search results are leads, not findings. For every lead, trace callers and tests
before assigning a status.

## Known inventory

This is the starting inventory for WP0, not a claim that discovery is complete.

| Guard family | Effective default or source | Class and action | Initial status | Owner / next action |
| --- | --- | --- | --- | --- |
| Interactive `maxTurns` | `agent.maxTurns=100` | Containment; throws `MaxTurnsExceededError` | `dependency` | Replace throw through the staged escalation design. |
| AgentRuntime `limits.maxTurns` | fallback `20`; child/parent values clamp | Containment; run-loop throw | `dependency` | Characterize separately from interactive and role-loader paths. |
| Role max turns | explorer/worker/librarian `200`; mentor `1`, subject to effective resolution | Containment | `dependency` | Test resolved, not merely declared, values. |
| Provider `maxOutputTokens` | `32_000`, clamped to catalog | Context/containment; provider may stop generation | `uncharacterized` | Trace incomplete/terminal semantics for every provider family. |
| Shared `GenerationGuard` | 100k characters/channel; request deadline `0`; repetition 4096 chars x3 | Runaway detector; typed unsafe abort | `candidate` | WP1 boundary and valid-periodic-output tests. |
| Foreground session repetition detector | 200 repeated chars, 8 repetitions, 4k window | Runaway detector; throws older untyped error | `candidate` | Highest-priority duplicate-owner characterization. |
| Codex WebSocket watchdog | 90s to first raw event; 600s between raw events | Inactivity; retryable abort/fallback | `candidate` | Prove raw lifecycle event taxonomy before changing defaults. |
| Retry attempts | `agent.retryAttempts=2` | Recovery budget; settles after retries | `uncharacterized` | Trace provider-specific retry and fallback accounting. |
| `InputSurgeGuard` | blocks 3 duplicated call/result IDs at 2 copies, or 20 duplicated signatures at 4 copies | Admission/advisory; pauses dispatch for explicit confirmation and one-turn bypass | `uncharacterized` | Prove legitimate full-history growth remains confirmable and the bypass cannot leak to another turn. |
| `AgentDefinition.limits.timeoutMs` | opt-in / undefined | Containment; `AbortSignal.timeout` cancels run | `candidate` | Add slow-valid and explicit-limit tests. |
| `ExecutionBudget.maxTokens` | opt-in / undefined | Containment; aborts shared tree after recorded usage | `dependency` | Integrate with staged budget judgment; do not patch locally. |
| `ExecutionBudget.maxChildren/maxDepth/maxConcurrency` | opt-in except resolved maxTurns | Admission | `uncharacterized` | Prove no admitted sibling is aborted on rejection. |
| Agent workflow timeout | 120s | Containment; aborts workflow | `candidate` | Characterize long active workflow without auto-extending it. |
| Agent workflow run/concurrency/code/output/console limits | 8 / 3 / 16KiB / 64KiB / 16KiB | Admission and context bounds | `uncharacterized` | Verify partial run summaries and typed failure results survive. |
| Foreground shell timeout | 120s; per-call `timeout_ms` wins | Containment; SIGTERM then SIGKILL | `candidate` | Preserve explicit override and partial output; never reset total time merely for output. |
| Background shell timeout | 30m; per-call `timeout_ms` wins | Containment; terminates job | `candidate` | Read background-shell plan before changes; verify terminal notification and retained output. |
| Shell retained buffer overflow | 1MiB; foreground kill, background truncate | Containment/context | `candidate` | Verify foreground harm and background retrievability separately. |
| Shell context output lines/chars | 1000 lines / 40k chars | Context bound | `uncharacterized` | Trace whether full output is spooled and discoverable. |
| `boundToolResultText` | 40k UTF-8 bytes | Context bound; spools artifact and appends path | `verified safe` | Retain existing contract tests. |
| Identical tool failure evidence | third identical `(tool,args,error)` gets advisory | Advisory/runaway | `candidate` | Current map is cumulative, not consecutive; characterize intervening success/mutation. |
| Hook callback timeout | 5s | Containment; hook times out without crashing session | `uncharacterized` | Verify fail-open/fail-closed behavior per hook kind. |
| Async subagent retention | 30m completed-session TTL; 50 retained user turns | Retention | `uncharacterized` | Prove eviction never cancels active work and reports lost resumability. |
| Queue/background registry capacity | configured or owner-specific | Admission | `uncharacterized` | Verify rejection is local and preserves existing/active entries. |
| Patch/edit healing timeout and file-size cap | helper defaults | Containment/fallback | `uncharacterized` | Verify original tool failure remains truthful when healing declines or times out. |
| Web fetch character cap | 10k default, 200k maximum | Context bound with continuation | `uncharacterized` | Verify continuation makes omitted content retrievable. |
| Context compaction thresholds | ratio 0.8; raw token threshold optional | Context management | `dependency` | Owned by provider-neutral compaction plan; audit only terminal failure behavior. |

## High-risk source profiles

These profiles contain current source facts. Their defect status remains governed
by the inventory table.

### A. Turn-count limits

- Interactive sessions read `agent.maxTurns` (default `100`).
- `AgentConfiguration` retains a nullish fallback of `20`, but normal settings
  supply the schema default.
- AgentRuntime `resolveLimits` separately defaults `limits.maxTurns` to `20` and
  clamps child limits against parent limits.
- Role files declare explorer/worker/librarian `200` and mentor `1`; tests must
  inspect the effective value used by the runner, not only role frontmatter.
- `ApplicationRunLoop` increments `state.turnCount` before each provider request
  and throws when it exceeds the effective maximum.
- Root and subagent settlement differ; subagents currently synthesize a partial
  final report for this error.

Disposition: implementation belongs to the staged budget plan. WP1 supplies
effective-value and settlement characterization so that later work does not
conflate the execution paths.

### B. Execution-tree token ceiling

- `ExecutionBudget.recordUsage()` adds completed child usage to shared
  `aggregateTokens`.
- At the configured maximum it aborts the shared controller, affecting active
  siblings as well as future admission.
- The limit is opt-in by default.
- Filesystem mutations already performed are not rolled back, but sibling final
  reports and in-flight provider outcomes may be lost.

Disposition: dependency on staged budget escalation. Do not replace the abort
until the judge/event contract is approved.

### C. Shell duration and overflow

- Foreground default timeout is 120s; background default is 30m.
- `timeout_ms` can override either value for an individual call before launch.
- Total command time pauses during sandbox network approval, but ordinary stdout
  does not extend it.
- Timeout sends SIGTERM, then SIGKILL after the grace period.
- Foreground retained-buffer overflow kills; background overflow retains the
  newest buffered data and keeps running.

Disposition: do not convert the total timeout into an activity timeout. WP1
tests partial-output settlement, per-call override, background notification, and
the foreground overflow false-positive scenario. Any behavior fix must preserve
process cleanup and the background monitor plan.

### D. WebSocket receive watchdog

- The watchdog wraps the raw provider event iterable.
- Any yielded raw event ends the first-frame phase; it need not contain visible
  text or reasoning.
- The next wait uses the 600s inter-frame timeout.
- First-frame and idle errors are retryable, with idle errors eligible for HTTP
  fallback.

Disposition: first characterize `response.created`, rate-limit/lifecycle events,
and the real treatment of protocol ping/pong. Do not describe “first frame” as
“first token,” and do not change defaults without traffic evidence.

### E. Model output guards

- The shared guard counts normalized text, reasoning, and observable tool
  argument growth. It uses a 100k per-channel/output default and a bounded exact
  periodic-suffix detector.
- Its hard request deadline is opt-in (`0` by default).
- Trips are `unsafeToReplay` because the provider may have accepted work.
- The older foreground session detector examines text only and can trip after a
  much smaller exact repetition (at least 200 repeated characters across at
  least eight repetitions).

Disposition: characterize both owners together. If the older foreground guard
can reject valid output or produces incompatible recovery, prefer deleting the
duplicate enforcement and relying on the shared provider-neutral owner rather
than tuning two detectors.

### F. Information-preserving bounds

`boundToolResultText` is the reference design: it bounds model context, saves the
complete payload to an artifact, and appends a retrieval path. It is not a
remediation candidate unless WP0 finds a caller that drops the artifact or note.

### G. Identical failure evidence

The current counter is cumulative for an exact `(tool name, arguments, error
message)` key. It is not reset by unrelated success or mutation, so it must not
be described as consecutive. The third occurrence returns stronger advisory
text but does not prevent execution.

Disposition: characterize an intervening state change. Any reset rule must use
an existing trustworthy effect signal; a harmless read must not let a genuine
failure loop evade detection.

### H. Input-surge admission

`InputSurgeGuard` detects duplicated tool-call history rather than raw input
size. A block pauses provider dispatch and routes through an explicit user
confirmation workflow whose bypass is scoped to the pending turn.

Disposition: retain the guard unless characterization shows a legitimate history
cannot be confirmed, the pending turn can be lost, or the bypass can authorize a
different turn. Treat those as admission-workflow defects, not as reasons to
raise replay thresholds first.

## Test contracts by guard class

### Inactivity watchdogs

Required:

1. no raw activity reaches the timeout and yields the intended typed error;
2. each meaningful raw lifecycle event resets the correct timer;
3. a raw lifecycle event with no normalized text switches from first-frame to
   inter-frame timing;
4. retry/fallback does not corrupt provider continuity or duplicate tools;
5. protocol ping/pong is counted only if the watched abstraction exposes it.

### Containment budgets

Required:

1. effective limit resolution is tested for default, persisted, role, parent,
   runtime, and per-call sources that exist for that guard;
2. approval wait is excluded where the owner contract says it is;
3. reaching the limit preserves truthful partial work and settlement evidence;
4. main-agent and subagent judgment follow the staged budget design;
5. explicit limits remain finite even when work is visibly active;
6. default-unbounded limits remain genuinely unbounded.

### Admission limits

Required:

1. rejection occurs before the rejected work starts;
2. existing admitted work remains active;
3. capacity is released exactly once on success, failure, and cancellation;
4. the rejection carries the effective limit and current count.

### Context and retention bounds

Required:

1. the consumer is told what was omitted;
2. omitted material is retrievable, or the terminal status explicitly says it
   is irrecoverable;
3. UTF-8 and structured payload boundaries remain valid;
4. eviction never aborts active work;
5. persistence and replay retain retrieval references.

### Runaway and advisory detectors

Required:

1. the genuine runaway pattern goes red and settles through the intended path;
2. valid periodic output above the trigger threshold does not false-positive, or
   the plan explicitly accepts and explains that containment trade-off;
3. boundary cases at threshold minus one, threshold, and threshold plus one are
   deterministic;
4. state changes that invalidate prior failure evidence are represented;
5. advisory guards never fabricate that a tool was not executed.

## Implementation work packages

```text
WP0 inventory and exclusions
  -> WP1 characterization and red proofs
      -> Human gate: confirm/refute candidates
          -> no confirmed defects -> WP3 ledger closure
          -> approved WP2 packages
              -> WP2A duplicate/output guards
              -> WP2B transport watchdogs
              -> WP2C shell containment
              -> WP2D admission/context bounds
              -> WP3 cross-path verification and ledger closure
          -> run-budget-stall-escalation implementation (separate approval and plan)
```

Only WP2 packages whose candidates are confirmed are executed.

### WP0 — Complete the inventory

Files:

- this ledger;
- settings schema and settings descriptions;
- enforcement and recovery owners found by the search commands;
- an `Excluded leads` appendix added to this file.

Steps:

1. Run the four discovery searches.
2. Deduplicate hits by enforcement owner, not setting name.
3. Trace every included hit from effective configuration through settlement.
4. Add missing inventory rows.
5. Add excluded leads with one-sentence evidence that they cannot affect agent
   execution, model context, persistence, or recovery.
6. Mark every row `uncharacterized`, `candidate`, `verified safe`, or
   `dependency`; do not mark a defect without red evidence.

Gate: every discovery hit is mapped or excluded, and every source link resolves
against the current tree.

Rollback: documentation-only commit; revert it directly.

### WP1 — Characterize the high-risk candidates

Add focused tests at the owning public boundaries:

1. **Effective turns:** root setting 100, AgentRuntime fallback 20, effective
   child/parent clamp, role-declared 200/1, root versus subagent settlement.
2. **Duplicate repetition owners:** valid exact-periodic output above 200 and
   4096 repeated characters; threshold boundaries; genuine runaway output.
3. **WebSocket frames:** `response.created` without visible output, subsequent
   inter-frame silence, genuine first-frame silence, idle fallback continuity.
4. **Shell:** explicit `timeout_ms`, active output crossing a small total
   timeout, truthful partial output, foreground overflow, background truncate
   and final notification.
5. **Agent timeout and workflow:** slow-valid completion with no configured
   AgentRuntime timeout; explicit timeout cancellation; workflow timeout with
   retained run summaries.
6. **Identical failures:** three immediate identical failures, intervening
   harmless read, and intervening trustworthy mutation/effect evidence.
7. **Input surge:** legitimate large/full-history input that triggers
   confirmation, cancel and confirm paths, and proof that the one-turn bypass
   cannot attach to replacement or queued input.
8. **Context bounds:** artifact/continuation survival through persistence and
   replay for each retrievable bound.

Use fake timers and fake providers/processes. Do not place destructive command
examples in ad-hoc shell probes.

Gate: each candidate has one fast deterministic command already run red against
the exact suspected false positive, or is downgraded with evidence. Present the
classification table to the user before WP2.

Rollback: tests and fixtures are one characterization commit. If a test encodes
an intended defect rather than current behavior, keep it isolated so the parent
commit can demonstrate red proof.

### WP2A — Repair duplicate or over-sensitive output guards

Entry condition: WP1 confirms a false positive or incompatible recovery between
the two repetition owners.

Preferred order:

1. make the shared provider-neutral `GenerationGuard` the single enforcement
   owner;
2. remove the foreground-only duplicate if its only remaining behavior is
   redundant;
3. preserve typed `unsafeToReplay` settlement and provider abort;
4. change thresholds only if boundary tests and captured legitimate output
   justify a new value;
5. preserve explicit configuration and migrate persisted defaults only when an
   exact legacy value can be identified safely.

Verification:

```bash
NODE_ENV=test pnpm test source/services/agent-runtime/application-run-loop.test.ts
NODE_ENV=test pnpm test source/services/session/session-stream-processor.test.ts
pnpm typecheck
pnpm test:provider-black-box
```

Rollback: one worktree and one commit; no unrelated provider changes.

### WP2B — Repair transport watchdog false positives

Entry condition: traffic or a deterministic provider fixture proves valid raw
silence exceeds the effective watchdog.

Steps:

1. correct activity observation at the raw transport boundary before increasing
   a timeout;
2. preserve distinct first-frame and inter-frame errors;
3. preserve retry/fallback and ambiguous-outcome rules;
4. change defaults only after comparing successful and failed traffic timings;
5. add a settings migration test if an old persisted default must change.

Verification:

```bash
NODE_ENV=test pnpm test source/providers/websocket-receive-watchdog.test.ts
NODE_ENV=test pnpm test source/providers/codex-responses-model.test.ts
pnpm typecheck
pnpm test:provider-black-box
```

Rollback: revert the transport commit. A persisted-setting migration is a point
of no return; it requires a pre-merge fixture proving customized values are
preserved and a documented downgrade behavior.

### WP2C — Repair shell containment without creating immortal processes

Entry condition: WP1 proves loss of legitimate work that cannot be avoided with
the existing per-call timeout or background mode.

Constraints:

- stdout alone never grants unlimited runtime;
- sandbox approval time remains excluded from the command budget;
- process-group cleanup and hard settlement remain bounded;
- partial output and terminal status stay truthful;
- foreground/background transfer and monitoring reuse existing owners.

Candidate repairs, chosen at the WP1 human gate:

1. improve launch guidance and selection of explicit `timeout_ms`/background
   mode when the command is predictably long;
2. expose a finite extension or transfer through the existing shell control
   surface if the command is already running;
3. replace foreground overflow kill with retrievable spooling only if memory and
   cleanup bounds remain explicit.

Verification:

```bash
NODE_ENV=test pnpm test source/utils/shell/execute-shell.test.ts
NODE_ENV=test pnpm test source/tools/system/shell.test.ts
NODE_ENV=test pnpm test source/services/shell/background-shell-registry.test.ts
pnpm typecheck
```

Rollback: each selected repair is a separate commit; overflow and timeout
changes are never bundled.

### WP2D — Repair admission, retention, and context bounds

Entry condition: WP1 shows admitted work is aborted, or omitted information is
not retrievable.

Steps:

1. move rejection before execution for admission defects;
2. keep active siblings untouched;
3. use the `boundToolResultText` artifact-note contract for recoverable large
   text where appropriate;
4. preserve explicit terminal evidence when data cannot be retained;
5. make TTL eviction completed-only and observable.

Verification uses the focused owner tests plus `pnpm typecheck`. Run the full
suite when a shared registry, queue, persistence, or tool-result utility changes.

Rollback: one guard owner per commit.

### Separate dependency — staged run budgets

Do not implement `maxTurns`, wall-clock/cost judgment, `ExecutionBudget` token
settlement, or identical-failure escalation independently from
[`run-budget-stall-escalation.md`](./run-budget-stall-escalation.md). WP0 and WP1
may improve their characterization tests. Runtime changes require explicit
implementation approval for that plan.

## Observability required before changing defaults

Every destructive guard trip should expose, without sensitive payloads:

- guard code and class;
- configured value and source;
- effective value after clamping/override;
- elapsed time or count;
- raw and normalized progress counters when applicable;
- execution path: root, foreground subagent, background subagent, workflow, or
  shell job;
- action taken: reject, warn, abort, kill, truncate, evict;
- recovery classification and retry/fallback decision;
- partial-output/artifact location when one exists.

Observability is not permission to log prompts, tool arguments, secrets, or full
provider frames.

### WP3 — Cross-path verification and ledger closure

Entry condition: every approved WP2 package is committed independently, its
focused checks pass, and any unapproved candidate remains unchanged.

Steps:

1. run the final verification matrix below from a built tree;
2. exercise each repaired guard through every applicable execution path: root,
   foreground subagent, background subagent, workflow, non-interactive mode, and
   shell foreground/background;
3. confirm cancellation, retry, fallback, partial-output, and provider-continuity
   settlement remain truthful at each repaired boundary;
4. update every inventory row with its final status, evidence command, and commit
   ID;
5. record baseline or environment failures separately from regressions;
6. update the `AGENTS.md` active/completed lists only after all approved packages
   are merged.

Gate: the ledger has no unexplained discovery hit or `confirmed defect` without
an approved disposition, all applicable mandatory suites have passed, and the
final diff contains no bundled unrelated guard changes.

Rollback: WP3 changes documentation and verification artifacts only. Revert a
failing runtime package by its independent WP2 commit; do not mask it by weakening
the cross-path assertion.

## Final verification

After all approved WP2 packages:

```bash
pnpm exec prettier --check <changed-files>
pnpm typecheck
NODE_ENV=test pnpm test
```

Additionally run `pnpm test:provider-black-box` for any provider, bridge,
run-loop, registry, or non-interactive change.

Report focused success separately from baseline, environment, or sandbox-only
failures. Never call a guard safe solely because its termination test passes.

## Completion criteria

The plan is complete when:

1. every mechanical lead is inventoried or explicitly excluded;
2. every inventory row has a source-backed effective value, action, recovery
   path, class, status, and owner;
3. every `confirmed defect` has a red-proof test and an independently revertible
   repair;
4. every destructive repair preserves truthful partial-work settlement;
5. provider/run-loop changes pass the provider black-box gate;
6. the human has approved the classification and each behavior-changing work
   package;
7. this document records final dispositions and commit IDs, then moves from the
   active list when the work is merged.

## Excluded leads

Populate this appendix during WP0. Each entry must name the source location and
why it cannot affect agent execution, model context, persistence, or recovery.
Do not use a blanket “test-only” or “UI-only” exclusion without tracing its
callers.
