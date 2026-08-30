# Periodic background-task check-ins

Status: **implemented and merged** (three phases, each squash-mergeable via
`git log --grep=background-checkin`). Read `docs/plans/background-work-control/MAP.md`,
`docs/plans/background-work-control/liveness-ui.md`, and `docs/plans/mid-turn-injection.md` before
touching any file this plan names — they define the vocabulary (Injection, Background Notification,
liveness) and the invariants this plan must not break.

## Resume here

All three phases below landed exactly as designed: no new turn-start primitive, the scheduler at
`source/services/session/background-check-in-scheduler.ts`, the `check_in` notification kind in
`subagent-notification-store.ts`, and `agent.backgroundCheckIn` in the settings schema. Every focused
suite, `pnpm typecheck`, and `pnpm test:provider-black-box` passed at merge time (Phase 3's commit).
The **Open questions** section below is resolved, not aspirational — read it for what was decided and
why, not as a TODO list.

One correction to the setting-wiring skill surfaced while wiring Phase 2: its checklist does not
mention `SETTINGS_SOURCE_KEYS` in `source/services/settings/settings-sources.ts` or the
`CONTRACT_04_CONSUMER_INVENTORY` fixture in `settings-schema.test.ts`. Both are separate explicit
per-field lists that a new setting must also join — `settings-sources.ts` builds the
`SettingsWithSources` value returned by `getAll()` via a hardcoded key list, not reflection, so
skipping it leaves the new setting silently `undefined` at every `.value`/`.source` read despite the
type system claiming it is populated (the cast `as SettingsWithSources` hides the gap). The next
setting added should update both, and the setting-wiring skill should probably gain these as a
seventh and eighth touchpoint.

## Goal

Today the main agent hears about a background shell job or background subagent run only when it
*settles* (`BackgroundNotification`, delivered at the launching turn's next request boundary, or by
opening a hidden model-only turn if the session has gone idle — `conversation-orchestrator.ts:1121`).
While the task is still running, only the human sees anything, via the passive liveness UI
(`background-task-activity.ts`, the compact panel, `Ctrl+G`).

This plan adds a proactive check-in: while a background task is still running and the session is
otherwise idle, the harness periodically opens a turn so the agent itself sees the task's current
status and decides — freely, with full tool access — whether to keep waiting, tell the user
something, or intervene (e.g. cancel a stuck job). It does not change execution, cancellation, or
transfer semantics for background work; it only adds a new reason a turn can open.

## Decided (2026-08-29, in conversation)

- **Trigger: fixed interval**, not a liveness/quiet threshold. A check-in fires every
  `intervalMs` while a task is running, regardless of whether that task has been producing output.
  The liveness fact (recent/quiet) still rides along in the payload so the agent can tell the
  difference — it just isn't the trigger.
- **Agent action: full turn, not a canned report.** A check-in opens the same kind of turn a
  settlement notification does — the agent has every tool it would normally have (including
  cancelling the task, e.g. `cancel_shell_job` / the subagent stop path in `BackgroundTaskControl`)
  and decides for itself. No new "status-only" turn variant.
- **On by default, capped.** Ships enabled; `maxCheckInsPerTask` bounds worst-case spend on a single
  long-running task. Once a task hits the cap, it stops receiving proactive wakes — it remains fully
  visible in the passive UI, only the proactive channel goes quiet for it.

## Mechanism (found in `## Resume here` research, confirmed by reading the code)

No new turn-start primitive is needed. The existing settlement-notification pipeline already does
everything a check-in needs; a check-in is just one more thing that flows through it:

1. **`SubagentNotificationStore.getTaskSnapshot()`** (`subagent-notification-store.ts:376`) already
   returns a unified `readonly BackgroundTask[]` across both executors —
   `BackgroundSubagentTask | BackgroundShellTask` (`:124`, `:146`), each carrying `status`,
   `startedAt`, and a stable id (`runId` / `jobId`). This is the enumeration surface; no new registry
   method is needed on `SubagentAsyncRegistry` or `BackgroundShellRegistry`.
2. **`recordBackgroundEvent`** (`session-composition.ts:480`) is the single funnel every background
   lifecycle event already goes through: it updates the task snapshot, calls
   `notificationStore.enqueue(event)` (which maps a `ConversationEvent` to a `BackgroundNotification`
   via `#notificationFor`, `subagent-notification-store.ts:477`), and fires `notificationObserver`.
3. **That observer is what wakes delivery** — it's wired in `conversation-orchestrator.ts:365-369` to
   call `#deliverBackgroundSubagentNotifications()`, which injects into the active turn if one is
   running (`#injectBackgroundSubagentNotifications`) or opens a hidden model-only turn via
   `conversationService.sendMessage(..., { suppressUserMessageDisplay: true })` if the session is
   idle (`:1121-1170`).

So a check-in is: a new `ConversationEvent` variant (e.g. `background_check_in_due`), a new
`#notificationFor` case producing a `check_in` `BackgroundNotification`, and a scheduler that calls
`recordBackgroundEvent` with that synthetic event when a running task's check-in is due. Everything
downstream — dedupe-by-messageId, drain/retain, idle-vs-active delivery, formatting — is reused
unchanged.

**Where the scheduler lives:** inside `createSessionRuntimeInternals` (`session-composition.ts`),
next to where `notificationStore` and `recordBackgroundEvent` are already in scope (~line 338-509).
It does not need direct handles to either registry — it reads `notificationStore.getTaskSnapshot()`
for running tasks and calls `recordBackgroundEvent` for the ones that are due. Use the injectable-timer
convention `SubagentAsyncRegistry` already follows (`setInterval`/`clearInterval` as deps, `.unref()`
on the handle, `subagent-async-registry.ts:131-132,168-172`) rather than inventing a shared scheduler
service — one poller in this same module is enough for both task kinds since `getTaskSnapshot()` is
already unified.

**Message id / dedupe:** unlike a completion, a check-in for the same task fires more than once, so
its `messageId` must include a sequence, e.g. `` check_in:${taskId}:${checkInIndex} ``, mirroring the
`seq` suffix pattern already used for repeating shell-monitor firings
(`background-shell-monitor/MAP.md`, "The `seq` suffix is what makes a repeating watch's firings
distinct under the store's exactly-once `messageId` dedupe").

**Cap enforcement:** the scheduler tracks `checkInCount` per task id itself (a `Map<string, number>`
alongside `lastCheckInAt`), not in the store — the store's job stays "was this exact message
delivered," not "how many check-ins has this task had." Cap and interval state for a task are
discarded when the task leaves the snapshot (settled and past the store's retention window).

## Open questions — resolved at implementation time

- **Payload richness — resolved: task identity + status + elapsed time, no liveness fact.**
  `BackgroundCheckInDueEvent`/`BackgroundCheckInNotification` carry `target`, `checkInIndex`,
  `elapsedMs`, and `details` (command, or role/task/name) — not `BackgroundTaskLiveness`. This was the
  simpler of the two options and was enough to satisfy the truthful-language rule: the formatter says
  "still running, elapsed Ns" and explicitly "does not by itself mean anything is wrong," never
  "hung." Wiring `background-task-activity.ts`'s liveness computation into the payload remains a
  future enhancement if a check-in ever needs to distinguish a quiet task from a noisy one; nothing
  here blocks that.
- **Batching — resolved: unchanged, relies on existing multi-notification handling.** The scheduler's
  `tick()` calls `emit()` (→ `recordBackgroundEvent`) once per due task, synchronously, in the same
  tick. Because `#deliverBackgroundSubagentNotifications` is async and its first synchronous section
  (checking `turnIsRunning`, then `pending.drain()`) runs to completion before the first `await`, two
  tasks due in the same tick do not each open their own hidden turn: the first call's `#beginTurn`
  increments `#activeTurns` before the second `emit()` fires its observer, so the second call sees
  `turnIsRunning === true` and injects into the first call's now-in-flight turn instead of opening a
  second one. This is pre-existing behavior of the shared pipeline (the same thing already happens
  when a shell completion and a subagent completion arrive close together) — check-ins introduce no
  new interleaving, so no new test was added for it beyond what already covers concurrent
  notifications.
- **Settings shape and defaults — resolved.** `agent.backgroundCheckIn = { enabled: true (default),
  intervalMs: 300_000, maxCheckInsPerTask: 3 }`, modeled on `runBudget`'s nested `z.object`. All
  mandatory and optional `setting-wiring` touchpoints are done, plus the two the skill's checklist
  omits (see `## Resume here`).
- **Formatter copy — resolved.** Both `formatBackgroundSubagentNotifications` and
  `formatBackgroundSubagentNotificationDisplay` gained a `check_in` branch with its own wording
  ("Periodic check-in on N still-running background tasks... Decide freely: doing nothing... is a
  valid choice"), not a copy of the completion wording.

## Implementation phases (all merged)

1. **Types and store plumbing** — `check_in` `BackgroundNotification` kind, `#notificationFor` case,
   formatter sections, `CommandMessage.tsx` transcript rendering. Pure types +
   `SubagentNotificationStore`/`conversation-orchestrator.ts` changes, unit-tested without any timer
   (store dedupe/lifecycle tests, orchestrator mid-turn-injection and idle-wake tests, a
   `CommandMessage` render test).
2. **Settings** — `agent.backgroundCheckIn` schema, dotted-path constants, defaults, `/settings` UI
   wiring per the `setting-wiring` skill, plus `settings-sources.ts` and the Contract 04 inventory
   (see `## Resume here`).
3. **Scheduler** — `BackgroundCheckInScheduler` in
   `source/services/session/background-check-in-scheduler.ts`: a fixed 30s poll tick (independent of
   the configurable `intervalMs`, so a runtime setting change needs no timer restart), reading
   `notificationStore.getTaskSnapshot()`, tracking per-task `lastCheckInAt`/`checkInCount` in memory,
   calling `recordBackgroundEvent` when due and under cap, gated by `agent.backgroundCheckIn.enabled`.
   Wired into `createSessionRuntimeInternals` right after the background event sinks are installed;
   disposed as the first step of the session's existing `dispose()`. Unit-tested with an injected
   clock/timer (due-time math, the cap, disposal, independent tasks, progress reset on leaving the
   running snapshot) plus an integration test in
   `session-composition.subagent-notifications.test.ts` using `vi.useFakeTimers()` to prove a real
   background shell job receives check-ins end to end and that disposal stops the timer.
   `pnpm test:provider-black-box` passed (171/172, one pre-existing unrelated skip) on this phase
   since it touches session composition.

No separate "Phase 4" was needed: the idle-hidden-turn and active-turn-injection paths were already
proven by Phase 1's orchestrator tests using synthetic `background_check_in_due` events, and Phase 3's
integration test proves the real scheduler drives the same observer seam those tests attach to — the
composition of the two is the end-to-end path, so a third redundant test spanning both layers was not
added.
