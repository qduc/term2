# Background work control

## Resume here

Background details, per-item stop, action notification, truthful root-shell transfer, and foreground-subagent transfer are implemented. Foreground-subagent transfer is an approval-capable lease adopted by the existing async registry, not cancel-and-restart; child approvals stay outside the root turn's singleton approval continuation.

Background-task liveness presentation is now planned in [liveness-ui.md](liveness-ui.md). It must surface observed activity and intentional waits without claiming that silence proves a task is hung; the task-manager shortcut is Ctrl+G to avoid tmux's default prefix.

Foreground and background subagent live cards are unified in [unified-subagent-ui.md](unified-subagent-ui.md): a transferred transcript card settles as `backgrounded`, the compact strip shares one row with an explicit placement tag, and `listDetails()` stays background-only.

Proactive check-ins on still-running background work are implemented, see [agent-checkin.md](agent-checkin.md): while a task runs and the session is idle, `BackgroundCheckInScheduler` periodically opens a turn so the agent — not just the human — sees current status and can decide to keep waiting, report, or intervene. It reuses the existing settlement-notification pipeline; no new turn-start primitive.

## Destination

Users can inspect and stop individual background subagents or shell jobs, move a running foreground subagent or shell execution into the background without restarting it, and the main agent is reliably told about execution-changing user actions so it can re-plan.

## Notes

- Execution is explicitly authorized by the user; this map stays open through implementation.
- Read `docs/plans/mid-turn-injection.md` before changing notification delivery or the run loop.
- Preserve the persistent background projection: async lifecycle events must not re-enter foreground message activity.
- `SubagentAsyncRegistry` and `BackgroundShellRegistry` remain execution lifecycle owners. Ink receives a narrow conversation-level control port, never a registry.
- A stop request is asynchronous (`cancelling` first, terminal settlement later) and must not suppress the ordinary completion notification.
- Opening details is observational and does not notify the main agent. Stop and foreground-to-background actions do.
- “Put in background” means true ownership transfer. Cancelling and relaunching is out of scope because it loses execution state and can duplicate mutating effects.
- The active menu-redesign Phase 5 worktree owns legacy input/menu deletion. The task manager is an app-level modal and must not revive `InputMode` or menu compatibility paths.
- Each slice uses TDD. Run-loop changes additionally require `pnpm test:provider-black-box`.

## Decided

- **Control ownership** — A session-owned background-work control port resolves typed task references and owns stop/detail policy; existing registries keep execution state.
- **Action delivery** — Successful execution-changing user actions use the existing durable drain/retain notification lane, which injects at an active request boundary or opens a hidden model-only turn while idle.
- **Stop semantics** — Force stop targets exactly one task and reports `cancelling`; global interrupt remains a distinct “stop everything” operation.
- **Transfer truthfulness** — Foreground work is never represented as background unless the same live execution and its cancellation/output ownership were transferred.
- **Shell transfer lease** — Root agent shell starts under a session-owned foreground lease that can be atomically adopted by `BackgroundShellRegistry`; the same controller, process promise, output, cleanup, and correlation survive the handoff. Direct Shell Mode is a separate lifecycle. → [detail](map/shell-transfer-lease.md)
- **Subagent transfer lease** — A foreground subagent needs an upfront session-owned lease with a stable run ID, independent controller, detachable parent abort, traffic context, progress/evidence, and one foreground-result resolver. The existing async registry cannot truthfully adopt a nested run created outside it. → [detail](map/subagent-transfer-lease.md)
- **Post-transfer subagent approvals** — A transferred subagent keeps its exact child continuation and pauses in a session-owned background approval queue. Ink presents one queued request at a time through a narrow control port; the decision resumes the child run directly and reuses approval policy without entering the root turn's pending-approval state. → [detail](map/background-subagent-approvals.md)

## Open

- **Direct shell mode** [research] — Does the requested foreground-shell action include commands launched from direct Shell Mode, whose current session only records completed history and exposes no process handle?
- **Task-manager merge point** [done] — After menu Phase 5 handed off, the app-level manager now lists and transfers foreground shells and subagents through the session-owned control port.
- **Unified live UI** [done] — Foreground and background subagent cards share one compact row; transfer settles the transcript. → [unified-subagent-ui.md](unified-subagent-ui.md)

## Fog

- Whether a future task-manager affordance should also link directly to the active approval; the shipped presentation uses global preemption.
- Whether shutdown should await every adopted subagent lease or use a bounded drain after cancellation; it must not report completion before the lease settles.

## Out of scope

- Silent cancel-and-restart presented as a move.
- Retry or relaunch controls for settled work.
- Sending model context merely because the user viewed details.
- Changing provider wire formats.

## Found in the territory

- 2026-08-08: Both background registries already expose rich status and per-item cancellation, but the UI projection is intentionally read-only and compact.
- 2026-08-08: Foreground subagents use `NestedSubagentRunner` with no async registry identity; foreground shell is awaited inline with no detachable process lease. The missing feature is execution ownership, not a button.
- 2026-08-08: Foreground agent shell currently reads `details.signal`, but `ApplicationRunLoop` supplies cancellation through `ToolInvocationContext.signal`. The live process therefore receives no run-loop abort signal. The transferable lease must bridge the context signal before handoff and detach that bridge only after atomic adoption.
- 2026-08-08: Foreground nested execution and async execution use different runners and state models. Starting an async run at click time would restart the task and can duplicate side effects; a truthful move needs an identity/abort/result lease created before execution begins.
- 2026-08-08: Implemented Ctrl+B retained details, per-item force stop, exact-once main-agent action notifications, and a same-process root-shell foreground lease adopted atomically by `BackgroundShellRegistry`.
- 2026-08-08: Independent review caught and closed two transfer defects: move notifications no longer masquerade as stop requests, and transferred output is capped by background policy.
- 2026-08-08: Verification passed: 305 focused tests before final review fixes, final 153-test review slice, typecheck, build, and provider black-box (18 files / 160 tests). The unrestricted provider run was required because the filesystem sandbox prevents normal PTY/log shutdown.
- 2026-08-08: Feasibility review confirmed `ApplicationRunLoop` already exposes the provider-neutral continuation primitive needed for truthful pause/resume. The missing work is lease ownership, registry adoption, approval policy/control, event routing, and Ink presentation; no provider wire-format change is required.
- 2026-08-08: The session now installs a FIFO approval controller for adopted child leases. It applies each decision through the existing approval policy to the exact retained continuation, never the root pending-approval state; shutdown keeps the durable subagent sinks attached until adopted leases settle.
- 2026-08-08: Foreground subagent candidates and truthful move now flow through the session-owned task-control port, including the ordinary background action notification. The task-manager presentation remains deferred behind menu Phase 5 ownership.
- 2026-08-08: The task-manager handoff is complete: BottomArea and the conversation hook project all foreground transfer candidates, and the modal confirms transfers using the executor-specific target identity. Focused Ink coverage and typecheck are green.
- 2026-08-08: Adopted-subagent approvals now globally preempt the composer through the existing approval prompt. Only the FIFO head is shown; later requests remain queued and the prompt reports their count. Decisions resolve through the session approval port using the exact revision and entry identity.
