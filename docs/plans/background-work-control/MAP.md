# Background work control

## Resume here

Background details, per-item stop, action notification, and truthful root-shell transfer are implemented and verified in `.worktrees/background-task-controls`. The remaining requested capability is foreground-subagent transfer. Before implementing it, resolve **Post-transfer subagent approvals** below: the current nested runner has no continuation handle that background UI can resume. Do not implement transfer as cancel-and-restart.

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

## Open

- **Post-transfer subagent approvals** [grill] — Must a transferred foreground subagent remain able to pause for a new nested tool approval? Full support requires a common pause-capable lease plus a background approval/resume UI; excluding it can strand work if an approval arises later.
- **Direct shell mode** [research] — Does the requested foreground-shell action include commands launched from direct Shell Mode, whose current session only records completed history and exposes no process handle?
- **Task-manager merge point** [task] — Reconcile the app-level input-owner/BottomArea integration after the active Phase 5 and double-Escape work hand off their overlapping files.

## Fog

- Whether transfer during an approval pause needs a separate state from transfer while an executor is already running.
- How provider continuation and cost attribution should identify a tool call whose result becomes a background handle before execution settles.
- Shutdown ordering when a transferred tool outlives the foreground turn but the session closes immediately afterward.

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
