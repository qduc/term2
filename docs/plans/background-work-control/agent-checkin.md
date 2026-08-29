# Periodic background-task check-ins

Status: **proposed.** No code written yet. Read `docs/plans/background-work-control/MAP.md`,
`docs/plans/background-work-control/liveness-ui.md`, and `docs/plans/mid-turn-injection.md` before
touching any file this plan names — they define the vocabulary (Injection, Background Notification,
liveness) and the invariants this plan must not break.

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

## Open questions for implementation time

- **Payload richness.** `BackgroundTask` (the snapshot type) does not carry the
  `BackgroundTaskLiveness`/`lastObservation` shape from `background-task-activity.ts` — that's
  computed separately, today only for the UI. Decide whether the check-in payload is worth extending
  to include it (truer "current status," matches the language liveness-ui.md already established) or
  whether task identity + status + elapsed time is enough for a first cut. Either way, reuse
  liveness-ui.md's truthful-language rule: a check-in must never claim a task is "hung," only that it
  has or hasn't produced observable activity recently.
- **Batching.** If two tasks are due in the same tick, should that produce one hidden turn with two
  `check_in` notifications, or one turn per task? The drain path already batches an array
  (`#deliverBackgroundSubagentNotifications` drains everything pending at once) — default to one
  turn, multiple notifications, unless a reason to split turns up surfaces during implementation.
- **Settings shape and defaults.** Model `agent.backgroundCheckIn` on `agent.runBudget`'s nested
  `z.object` (`settings-schema.ts:101`): `{ enabled: boolean (default true), intervalMs: number
  (default 300_000), maxCheckInsPerTask: number (default TBD — 3 was floated in conversation, not
  committed) }`. Needs dotted-path constants and a defaults-object entry alongside `runBudget`'s, and
  must go through the `setting-wiring` skill's checklist so it actually appears in `/settings`.
- **Formatter copy.** `formatBackgroundSubagentNotifications` / `formatBackgroundSubagentNotificationDisplay`
  (`conversation-orchestrator.ts:52`, `:249`) need a `check_in` branch. Wording is a fresh decision,
  not a copy of the completion wording — a check-in is not news of an outcome.

## Implementation phases (proposed; each its own worktree per `AGENTS.md`)

1. **Types and store plumbing** — `check_in` `BackgroundNotification` kind, `#notificationFor` case,
   formatter sections. Pure types + `SubagentNotificationStore`/`conversation-orchestrator.ts`
   changes, unit-testable without any timer.
2. **Settings** — `agent.backgroundCheckIn` schema, dotted-path constants, defaults, `/settings` UI
   wiring per the `setting-wiring` skill.
3. **Scheduler** — the interval poller in `session-composition.ts`, reading
   `notificationStore.getTaskSnapshot()`, tracking per-task `lastCheckInAt`/`checkInCount`, calling
   `recordBackgroundEvent` when due and under cap, gated by `agent.backgroundCheckIn.enabled`.
   Injected clock/timer in tests; no real timers.
4. **End-to-end wiring and black-box coverage** — confirm a check-in actually opens a hidden turn when
   idle and injects when a turn is active, that the cap stops further wakes, and that a settling task
   removes it from scheduling. Run `pnpm test:provider-black-box` since this touches the run loop's
   turn-opening path (per `AGENTS.md`'s provider-testing requirement).
