# Background shell monitor

Status: plan. Waiting on implementation approval.

## Destination

The agent can attach a **watch** to a running background shell job and be told,
without polling and without ending the job, when that job's output says something
worth reacting to — a server printed its listening port, a watcher printed a
compile error, a long migration printed a progress marker. The process keeps
running; the notification arrives through the same durable background lane that
already delivers job completions.

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

## Open

- **Watch budget per session.** Unbounded watches on unbounded jobs is a
  notification-flood surface. A per-job cap (say 4) and a session cap are
  probably right, but the numbers are a guess until it is used.
- **Does a firing wake an idle session?** The lane supports opening a hidden
  model-only turn when idle. Correct for a completion; for a monitor hit it means
  a background log line can start a turn the user never asked for. Leaning toward
  injecting at a request boundary only, and deferring an idle-session firing until
  the next turn — but this is a product call, not a technical one.
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

## Implementation slices

Each is TDD, each is independently reviewable.

1. **Chunk tap.** `onOutputChunk?: (stream, text) => void` on `ExecuteShellOptions`
   and `ExecOptions`; `overflow: 'kill' | 'truncate'`. Tests in
   `execute-shell.test.ts`: chunk ordering, partial-line delivery, truncate does
   not kill, foreground kill behaviour unchanged.
2. **Store.** `BackgroundShellOutputStore` — ring buffer, line assembly, drop
   accounting, retention. Pure and fully unit-testable with no process.
3. **Watches.** Registration, replay from offset, debounce, `notifyLimit`,
   retirement on terminal status, flush-before-completion ordering. Injected
   clock; no real timers in tests.
4. **Event and notification plumbing.** `background_shell_output` through
   `agent-client`, `conversation-events`, `conversation-decoder`,
   `conversation-replay`, `conversation-logger`, `SubagentNotificationStore`,
   `ConversationOrchestrator` formatters.
5. **Tools and UI.** `monitor_shell_job`, `cancel_shell_monitor`, their
   formatters, and the `get_shell_job` tail.
6. **Settings.** `shell.backgroundTimeout` plus `/settings` wiring.

Slices 1 and 4 touch the run loop and notification delivery, so
`pnpm test:provider-black-box` runs as part of development on those, not at the
end. Read `docs/plans/mid-turn-injection.md` before slice 4 — it owns the
vocabulary (Segment, Request Boundary, Injection, Background Notification) this
delivery path is described in.
