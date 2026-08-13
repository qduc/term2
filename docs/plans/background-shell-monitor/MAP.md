# Background shell monitor

Status: plan — implementation is tracked here in six phases. **All six phases
merged 2026-08-10**: chunk tap 6d886844, output store c2ed6c83, watches
de1484f0, notification plumbing 0fc912e7, tools & UI 8c053098, settings
78e5a08c. Feature complete; the plan's design record can be dropped once its
notes stop earning their place. The idle-session-wake product call was approved
at kickoff — see `## Decided`.

## Resume here

Read this before touching anything this plan covers. Six phases implement the
feature. All six phases are merged into main: chunk tap 6d886844, output
store c2ed6c83, watches de1484f0, notification plumbing 0fc912e7, tools & UI
8c053098, settings 78e5a08c — worktrees and branches removed. The feature is
complete: the agent can attach a watch to a running background shell job, be
notified through the durable lane when its output matches, and read the real
tail via `get_shell_job`; background launches use `shell.backgroundTimeout`
(30 min, capped) and `overflow: 'truncate'`. The ground-truth notes in
`## Found in the territory` (overflow-kill result shape, watch-layer pins,
pre-existing ink-layer and black-box failures) are worth keeping for adjacent
work. Approved at kickoff (2026-08-10): monitor firings may wake an idle
session — see `## Decided`.
1 → 2 → 3 are a strict
build-up, 4 builds on 3, 5 builds on 4, and 6 is independent. Each phase is TDD
and lands in its own worktree (`.worktrees/background-shell-monitor-N-<slug>`),
is merged back from the primary checkout with `git merge --no-ff`, then the
worktree and branch are removed before the next phase starts — the AGENTS.md
parallel-work-isolation convention. Phases 1 and 4 touch the run loop and
notification delivery, so `pnpm test:provider-black-box` runs during development
on those, not at the end. Read `docs/plans/mid-turn-injection.md` before phase 4
— it owns the vocabulary (Segment, Request Boundary, Injection, Background
Notification) this delivery path is described in. The parent single-file plan was
moved here on 2026-08-10; `## Found in the territory` records the one stale path
(`source/utils/shell/shell.ts` → `source/tools/system/shell.ts`).

## Destination

The agent can attach a **watch** to a running background shell job and be told,
without polling and without ending the job, when that job's output says something
worth reacting to — a server printed its listening port, a watcher printed a
compile error, a long migration printed a progress marker. The process keeps
running; the notification arrives through the same durable background lane that
already delivers job completions.

## Notes

- Each phase is a feature-sized unit owning its own worktree under `.worktrees/`;
  never stack two phases in one worktree.
- Preserve foreground behaviour: phase 1 keeps the `'kill'` overflow default for
  foreground, phase 5's `get_shell_job` tail is additive to
  `background_job_active`, and phase 6's `timeout_ms` still overrides
  `shell.backgroundTimeout`.
- Exchange the chunk type through the shell seam only. Do not widen
  `BackgroundShellRegistry` (already generic over `TResult`) to carry output text.
- Delivery reuses the existing durable lane; the `seq` suffix in
  `shell_output:${jobId}:${watchId}:${seq}` keeps repeat firings distinct under
  the exactly-once `messageId` dedupe. Never emit a monitor notification after
  the job's terminal notification.
- Store and watch phases stay pure. The shell-tool seam (open the store stream
  at `registry.launch`, close it in the already-passed `onSettled` callback,
  `shell.ts:920`) is wired in **phase 5**, not phases 2–3; phases 2–3 drive the
  store only through its own API.
- Update `## Resume here` and the per-phase status on every phase transition.
  Per AGENTS.md, move the plan down (or drop it) once its design record stops
  earning its place.

## Why this is not a small change

Three properties of today's implementation each block the feature outright. Any
plan that does not address all three does not work.

1. **No incremental output exists.** `defaultExecImpl` in
   `source/utils/shell/execute-shell.ts:77` accumulates `stdout`/`stderr` into two
   strings and hands them to its callback once, at settlement. Nothing observes a
   chunk as it arrives. Monitoring needs a tap at that seam; there is no other
   place to get the data.

2. **Background jobs are killed after two minutes.** `shell.timeout` defaults to
   `120000` and `shell.ts:610` applies it to background launches identically to
   foreground ones. The processes most worth monitoring are exactly the ones that
   outlive that.

3. **A talkative process gets killed at 1 MB.** `maxBuffer` overflow does not
   truncate — it sets an error and calls `stopChildProcess`
   (`execute-shell.ts:149-152`). A dev server monitored for an hour will trip
   this and die, and the death will look like a command failure.

## Decided

### Watch, not tail-follow

"Notify on a new line" is the wrong default. A dev server emits hundreds of lines
per minute; waking the agent per line would burn the context window and interrupt
every turn. The unit is a **Watch**: a job-scoped subscription with a trigger
policy, a delivery budget, and a lifetime bounded by its job.

```ts
interface ShellOutputWatch {
  watchId: string;
  jobId: string;
  pattern?: RegExp;            // absent = any output
  stream: 'stdout' | 'stderr' | 'both';
  idleMs: number;              // coalescing window, default 1500
  notifyLimit: number;         // default 1 when a pattern is set, 5 otherwise
  fromOffset: number;          // replay position, default 0
}
```

Trigger semantics: a watch fires when a **complete line** in the selected stream
matches `pattern` (or, with no pattern, when any new complete line arrives), and
then only after `idleMs` of quiet — so a burst of 200 lines produces one
notification carrying the burst, not 200 notifications. A watch retires when it
has fired `notifyLimit` times, when its job reaches a terminal status, or when
`cancel_shell_monitor` names it.

### Watches replay from job start

A watch evaluates against the retained buffer beginning at `fromOffset`, which
defaults to 0 — the start of the job. This is the whole reason no launch-time
`monitor` parameter is needed. Without replay there is an unavoidable race: the
model runs `shell(command: "npm run dev", background: true)`, then registers a
watch for `Listening on`, and that line was already printed between the two tool
calls. With replay, registering the watch after the fact is correct, so the
launch path stays unchanged and the monitor surface stays orthogonal to it.

### Line boundaries are the buffer's job, not the matcher's

Chunks arrive on arbitrary byte boundaries. The buffer holds a partial-line
remainder and exposes only completed lines to matching (flushing the remainder at
EOF). Otherwise a pattern can match across a chunk split, or match half a line
that later turns out to say something else — a defect that would reproduce maybe
one run in fifty and be untestable after the fact.

### A separate output store, not a generic registry parameter

`BackgroundShellRegistry` is generic over `TResult` and deliberately knows nothing
about output text. Threading a chunk type through it would widen a deep, narrow
contract for one caller's benefit.

Instead: a session-owned `BackgroundShellOutputStore`
(`source/services/shell/background-shell-output-store.ts`), keyed by `jobId`,
holding one ring buffer and the watch set per job. The shell tool already has the
exact seam to keep it in sync without any new coupling — it opens the stream when
it calls `registry.launch`, and closes it in the `onSettled` callback it already
passes (`shell.ts:920`). Retention is the store's own concern: a bounded number
of settled jobs' buffers survive for post-hoc reads, matching the registry's
`maxRetainedJobs` in spirit but not by reference.

### Bounded, chronological, lossy-but-honest buffer

One ring buffer per job holding tagged records `{stream, text}` in arrival order —
chronological, unlike the final result which keeps stdout and stderr separate.
Cap by both bytes and lines (proposal: 256 KB / 2000 lines). When the ring
evicts, increment a `droppedBytes`/`droppedLines` counter and surface it in every
read, so the model is never shown a silently incomplete tail.

### Delivery reuses the existing notification lane

A new `BackgroundNotification` kind:

```ts
{
  kind: 'shell_output';
  messageId: `shell_output:${jobId}:${watchId}:${seq}`;
  jobId; command; watchId;
  matchedLines: string;   // capped, ~4 KB
  droppedBytes?: number;
}
```

It flows through the paths that already exist and are already tested:
`BackgroundShellEvent` → `agent-client.ts:755` → `ConversationEvent` →
`SubagentNotificationStore.enqueue` → `ConversationOrchestrator`'s drain, which
injects at an active request boundary or opens a hidden model-only turn when
idle. `formatBackgroundSubagentNotifications` and
`formatBackgroundSubagentNotificationDisplay` each gain one section. The `seq`
suffix is what makes a repeating watch's firings distinct under the store's
exactly-once `messageId` dedupe.

**Ordering rule:** on terminal settlement, flush any matched-but-undelivered
watch content *before* emitting `background_shell_completed`, then retire the
job's watches. A monitor notification arriving after its job's completion
notification would read as new activity on a dead job.

### Monitor firings may wake an idle session (approved 2026-08-10)

A `shell_output` firing may open a hidden model-only turn when the session is
idle, via the same idle drain `ConversationOrchestrator` already opens for job
completions. A monitor hit is most actionable exactly when nothing else is
happening in the conversation — a server printing "Listening on" mid-idle is the
case the watch exists for. Constraints unchanged: never emit a monitor
notification after the job's terminal notification, and the `seq`-suffixed
`messageId` dedupe rule still applies.

### Tool surface

Two new tools next to `get_shell_job` / `cancel_shell_job` in
`createBackgroundShellJobToolDefinitions` (`shell.ts:200`):

- `monitor_shell_job({ job_id, pattern?, stream?, idle_ms?, notify_limit?, once? })`
  → `{ watchId, jobId, status }`.
- `cancel_shell_monitor({ watch_id })`.

Both need a `formatCommandMessage`. This is not optional politeness — the comment
at `shell.ts:141` records why: the UI opens a `running` command row on every
`tool_started` and closes it only when a command message arrives for that
`callId`. A formatter returning `[]` strands the row, and a stranded running row
keeps every message behind it out of Ink's `Static` region for the rest of the
session.

### `get_shell_job` starts telling the truth about running jobs

Today it refuses to show anything for a running job (`shell.ts:132-139`,
`background_job_active`). Once a buffer exists, that refusal is just withholding
data the process already has. Change it to return the bounded tail plus
`droppedBytes` alongside the existing "do not poll; completion is delivered
automatically" instruction. The transcript formatter's `background_job_active`
branch shows the tail instead of `'Still running.'`.

### Timeout and overflow policy

- Add `shell.backgroundTimeout` (proposal: 30 minutes) applied to background
  launches in place of `shell.timeout`, with `timeout_ms` still overriding.
  Capped, never unbounded: `registry.dispose()` must stay a terminating
  operation, and an unbounded child is an orphan waiting to happen.
- Add `overflow: 'kill' | 'truncate'` to `ExecuteShellOptions`. Background jobs
  use `'truncate'`: on `maxBuffer` overflow, drop from the head of the retained
  final-result text and keep running, rather than setting `ex` and signalling the
  child. Foreground keeps `'kill'` — unchanged behaviour, unchanged tests.

Wire `shell.backgroundTimeout` through the `setting-wiring` skill's checklist so
it appears in `/settings`.

## Implementation phases

Dependency order is forced: 1 → 2 → 3 are a strict build-up, 4 builds on 3,
5 builds on 4, and 6 is independent (it can land anytime). Each phase is TDD and
independently reviewable, each in its own worktree.

### Phase 1 — Chunk tap

- **Worktree:** `.worktrees/background-shell-monitor-1-chunk-tap`
- **Scope:** `onOutputChunk?: (stream, text) => void` on `ExecuteShellOptions` and
  `ExecOptions`; `overflow: 'kill' | 'truncate'`.
- **Tests** (`execute-shell.test.ts`): chunk ordering, partial-line delivery,
  truncate does not kill, foreground kill behaviour unchanged.
- **Obligations:** the execution seam — run `pnpm test:provider-black-box` during
  development on this phase.
- **Status:** completed — merged to main as 6d886844 (feature commit
  318ab0a6); worktree and branch removed. The kill-overflow test asserts only
  the observable surface (see `## Found in the territory`, 2026-08-10).

### Phase 2 — Output store

- **Worktree:** `.worktrees/background-shell-monitor-2-output-store`
- **Scope:** `BackgroundShellOutputStore`
  (`source/services/shell/background-shell-output-store.ts`) — ring buffer, line
  assembly, drop accounting, retention. Pure unit; no process.
- **Tests:** fully unit-testable without a real child.
- **Status:** completed — merged to main as c2ed6c83 (feature commit
  c4b1289a); worktree and branch removed.

### Phase 3 — Watches

- **Worktree:** `.worktrees/background-shell-monitor-3-watches`
- **Scope:** registration, replay from `fromOffset` (default 0), `idleMs`
  debounce, `notifyLimit`, retirement on terminal status,
  flush-before-completion ordering.
  replay from the head of the retained buffer; lines evicted before
  registration are not replayable (their bytes surface as `droppedBytes`); "no
  idle time" (idleMs 0) fires each concerned push window. These are pins, not
  defects — see `## Found in the territory`.
- **Tests:** injected clock; no real timers in tests.
- **Status:** completed — merged to main as de1484f0 (feature commit d90eb170);
  worktree and branch removed.

### Phase 4 — Event and notification plumbing

- **Worktree:** `.worktrees/background-shell-monitor-4-notification-plumbing`
- **Scope:** `background_shell_output` (the `BackgroundNotification` kind in
  `## Decided`) through `agent-client`, `conversation-events`,
  `conversation-decoder`, `conversation-replay`, `conversation-logger`,
  `SubagentNotificationStore`, and `ConversationOrchestrator` formatters; the
  flush-before-completion ordering rule.
- **Obligations:** read `docs/plans/mid-turn-injection.md` first; run
  `pnpm test:provider-black-box` during development on this phase.
- **Status:** completed — merged to main as 0fc912e7 (feature commit
  153ef757); worktree and branch removed. Validation note: the generous
  (always-on) idle-wake path needs no orchestrator change — the generic drain
  already opens a hidden model-only turn for any pending notification.

### Phase 5 — Tools and UI

- **Worktree:** `.worktrees/background-shell-monitor-5-tools-ui`
- **Scope:** `monitor_shell_job` and `cancel_shell_monitor` next to
  `get_shell_job` in `createBackgroundShellJobToolDefinitions`
  (`source/tools/system/shell.ts:200`) with `formatCommandMessage` for both (the
  stranded-running-row rule at `shell.ts:144`); `get_shell_job` returns the
  bounded tail plus `droppedBytes` for running jobs; the transcript
  `background_job_active` branch shows the tail instead of `'Still running.'`.
- **Scope:** `monitor_shell_job` and `cancel_shell_monitor` next to
  `get_shell_job` in `createBackgroundShellJobToolDefinitions`
  (`source/tools/system/shell.ts:200`) with `formatCommandMessage` for both (the
  stranded-running-row rule at `shell.ts:144`); `get_shell_job` returns the
  bounded tail plus `droppedBytes` for running jobs; the transcript
  `background_job_active` branch shows the tail instead of `'Still running.'`.
  The shell-tool seam (store open at `onStarted`, chunk push through the
  watches, `settleJob` in `onSettled`) is wired here.
- **Status:** completed — merged to main as 8c053098 (feature commit
  3d89d4ea); worktree and branch removed.

### Phase 6 — Settings

- **Worktree:** `.worktrees/background-shell-monitor-6-settings`
- **Scope:** `shell.backgroundTimeout` (proposal: 30 min, capped — never
  unbounded) applied to background launches in place of `shell.timeout`, with
  `timeout_ms` still overriding; wire through the `setting-wiring` skill checklist
  so it appears in `/settings`.
- **Status:** completed — merged to main as 78e5a08c (feature commits
  877ed317, 10cbdebe); worktree and branch removed. `shell.backgroundTimeout`
  default 30 min, positive-int, capped; background launches read it in place of
  `shell.timeout` with `timeout_ms` precedence, and pass `overflow: 'truncate'`;
  foreground unchanged (`'kill'`).

## Open

- **Watch budget per session.** Unbounded watches on unbounded jobs is a
  notification-flood surface. A per-job cap (say 4) and a session cap are
  probably right, but the numbers are a guess until it is used.

- **Sandboxed long-lived processes.** `withSandboxExecutionLease`
  (`execute-shell.ts:35`) serialises sandboxed executions holding the network
  approval lease. A 30-minute monitored sandboxed job would block every other
  sandboxed command for 30 minutes. Needs measuring before the timeout is raised;
  it may force monitored jobs to be unsandboxed-only, which is a significant
  narrowing.

## Fog

- Whether the task manager (Ctrl+B) should show monitored jobs distinctly, and
  whether a user should be able to attach a watch from the UI.
- Whether a watch should support a negative condition ("notify if nothing matched
  in 5 minutes"), which is a different timer and a different failure mode.

## Out of scope

- Writing to a running job's stdin. That is a different capability
  (`ShellInteractionSession` territory) with its own approval questions.
- Monitoring SSH-backed or foreground jobs. Background is local-only today
  (`shell.ts:578`) and this changes nothing there.
- Streaming a job's output live into the transcript. The transcript stays
  event-shaped; monitoring produces discrete notifications, not a feed.

## Found in the territory

- 2026-08-10: Plan promoted to this phase-tracked MAP. Re-verified the three
  blocking properties against the current tree: `defaultExecImpl`
  (`execute-shell.ts:77`) still delivers settled strings only with no
  `onOutputChunk`/`overflow`, the 120000 ms default still applies to background
  launches (`source/tools/system/shell.ts:611`), and `maxBuffer` overflow still
  sets `ex` and kills the child (`execute-shell.ts:149-152`).
- 2026-08-10: One plan path is stale. The shell tool moved from
  `source/utils/shell/shell.ts` to `source/tools/system/shell.ts` (UI/business
  layer separation); `createBackgroundShellJobToolDefinitions` and the stranded
  running-row `formatCommandMessage` note still sit at `shell.ts:200`/`shell.ts:144`.
- 2026-08-10: Phase 1 merged. The black-box suite has one pre-existing failure
  (`provider-session-resilience` > reasoning traffic not persisted under the
  workspace's Library/Logs) reproducible on pristine main; isolated via stash +
  rebuild during phase 1. Not caused by the phase-1 change. Root cause fixed
  2026-08-13: the test helper `readProviderTraffic` hard-coded a macOS path
  (`join(root, 'Library', 'Logs')`); it now reads the platform-resolved
  `workspace.paths.logDir` (`envPaths('term2').log`) and the assertion passes on
  Linux, macOS, and Windows. One lane gap remains: the OpenAI WebSocket lane
  records no provider traffic (unlike codex WebSocket and HTTP lanes), so that
  single scenario still `ctx.skip()`s when no traffic file exists.
- 2026-08-10: Overflow-kill never surfaces an error on `ShellExecutionResult` —
  the type has no `error` field. `defaultExecImpl` sets `ex`, and the wrapper
  converts the rejection into `{ exitCode: null, signal: null, timedOut: false }`
  via its catch. So an overflow-killed job reads as "killed, no exit code" to
  callers, not as an error. Relevant to phase 5's `get_shell_job` content.
- 2026-08-10: Phase 2 merged. Two implementation pins worth carrying forward:
  byte accounting counts line text only (terminators not counted; UTF-16
  `length`, matching `execute-shell.ts`'s `maxBuffer` convention), and
  `readTail` orders cross-stream content chronologically but is approximate when
  a job holds two partial lines at once (both documented in the module).
  Retention default is `maxRetainedJobs: 20`.
- 2026-08-10: Phase 3 merged. Watch-layer pins: `stream` defaults to `'both'`;
  `fromOffset` is a count of retained complete lines to skip (a watch registered
  after eviction cannot replay evicted lines — `droppedBytes` already says so);
  the idle `idleMs` debounce resets only on new *matches for that watch*, so
  noisy unrelated output never delays a firing; `settleJob` cancels debounce,
  flushes pending firings synchronously, then retires (all before it returns,
  so the caller can emit the job's completion and no monitor firing can follow).
- 2026-08-10: Phase 4 merged (0fc912e7). Two validation findings worth
  recording: **the full unit suite has ~590 pre-existing failures in the Ink
  component layer** (`act is not a function` in `renderInAct`, ink-testing.tsx)
  that reproduce on pristine main and are unrelated to this plan — targeted
  suites are the meaningful gate here, not the full run; and the black-box
  suite result is unchanged from phase 1 (127 pass / 1 pre-existing
  provider-session-resilience failure / 17 skipped). Phase 4 needed one defect
  fix during validation: the replay `background_shell_completed` handler
  clobbered any firings recorded before settlement — fixed to preserve them.
