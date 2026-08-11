# Background-task liveness UI

Status: plan. Waiting for implementation authorization.

## Problem

The compact background-task panel says only that a task is running and how
long it has existed. That makes normal quiet work (a provider request, a
long-running shell command, or a subagent awaiting approval) indistinguishable
from an execution that has stopped producing observable progress. Ctrl+B also
collides with tmux's default prefix, making the manager awkward to reach from
the common nested-terminal case.

## Outcome

The UI makes a careful distinction between observable activity, intentional
waiting, silence, and terminal failure. It never presents a task as "hung"
solely because it has not emitted text. The persistent panel gives an at-a-
glance summary; the task manager gives enough evidence to decide whether to
inspect or stop one task.

`Ctrl+G` opens and closes the background-task manager. It replaces Ctrl+B in
all hints, handlers, and interaction tests. Ctrl+G is deliberately scoped to
the app's background-task manager; it does not alter the manager's `[b] Put in
background` action for a selected foreground task.

## Design

### Normalized activity evidence

Add a small, presentation-neutral activity snapshot to the session-facing
`BackgroundTaskControlDetails` union:

- `activity`: a typed current state such as `working`, `waiting_for_provider`,
  `awaiting_approval`, `cancelling`, or `quiet`;
- `lastActivityAt`: the timestamp of the last observable event;
- `activitySummary`: a bounded human-readable description of the most recent
  work, for example `Running shell command`, `Calling read_file`, or `Waiting
  for approval`.

Keep classification policy in the session/control seam, not in Ink. The
subagent registry remains the authority for subagent lifecycle and captured
tool/text progress; the shell registry remains the authority for shell
lifecycle. `BackgroundTaskControl` normalizes their records for presentation.

The subagent record updates activity time on every owned text-stream,
text-turn, tool-start, approval-state transition, cancellation, and terminal
event. Its existing `lastToolAt` stays a tool-specific diagnostic rather than
being overloaded as generic liveness.

The shell record gains activity time and a bounded last-activity summary from
process start, stdout/stderr chunk receipt, stop request, and settlement. Do
not retain unbounded shell output merely to display liveness. If the shell
execution adapter cannot report output chunks, surface it as `working` with
`Started command; no output observed yet`, rather than manufacturing a
heartbeat.

### Silence policy

Classify a live task from evidence, never from elapsed duration alone:

| Condition | UI wording | Meaning |
| --- | --- | --- |
| Recent owned event | `Working · last activity 4s ago` | Progress was observed. |
| Known blocking state | `Waiting for provider response` / `Waiting for approval` | Silence is expected and the reason is known. |
| Live task past a state-specific observation threshold with no event | `No observed progress for 1m 12s` | A prompt to inspect or stop, not a hang diagnosis. |
| Timeout, exit, or explicit lifecycle failure | Existing terminal status plus concrete error | A confirmed outcome. |

Thresholds are one named policy constant with per-state values, injected or
tested with a clock. Start conservative and make them observable in unit tests;
they must not cause a provider request or quiet but live shell process to be
marked failed. A task remains cancellable in `quiet` just as in `working`.

### Presentation

`BackgroundTasksPanel` becomes a compact live summary:

```text
Background tasks · 2 active · Ctrl+G manage
• [Worker] Audit fixtures               Working · 42s · last activity 3s ago
  └ ▶ rg provider fixtures
• [Shell] pnpm test                     No observed progress for 1m 12s
```

Use stable text/icons rather than a fast spinner as the only signal. If a
subtle spinner is added, it is decorative; status and activity age must remain
readable in copied terminal output and snapshot tests.

`BackgroundTaskManager` lists the same concise status and, in details, shows
started time, elapsed time, last observed activity, its source/summary, latest
tool or shell output excerpt, and terminal error if any. Keep the existing
stop confirmation and durable user-action notification semantics unchanged.

### Input ownership and shortcut migration

Define the manager shortcut once (for example, an exported
`BACKGROUND_TASK_MANAGER_SHORTCUT` matcher) rather than scattering `key.ctrl &&
input === 'b'`. The modal owns Ctrl+G only when it is eligible according to the
existing `deriveInputOwner` result. Higher-priority approval and setup prompts
continue to preempt it; Ctrl-C and Ctrl-D remain root-owned signal keys.

When the manager is open, Ctrl+G closes it. When it is closed, Ctrl+G opens it
only if it has a background or transferable foreground task. No other view may
also interpret the key. Update visible hints, the foreground-shell hint, and
the modal behavior together.

## Implementation slices

1. **Specify the control contract first.** Add focused tests for normalized
   activity state, clock-driven quiet classification, known waiting states, and
   shell records with no output. Add the smallest timestamps/event updates to
   `subagent-async-registry.ts` and `background-shell-registry.ts`, then map
   them through `background-task-control.ts`.
2. **Project the status in the compact panel.** Update
   `BackgroundTasksPanel.tsx` and its tests to show activity age/reason for
   running tasks, while preserving concise retained terminal rows.
3. **Expose the evidence in the manager.** Update
   `BackgroundTaskManager.tsx` and tests for list and details rendering,
   including quiet tasks remaining stoppable and waiting tasks not being styled
   as failures.
4. **Migrate Ctrl+B to Ctrl+G.** Centralize the matcher, update `BottomArea`,
   manager tests, and input-owner tests. Cover open, close, preemption by an
   urgent prompt, ignored state with no tasks, and one-key/one-transition
   behavior.
5. **Validate the integration.** Run the focused registry, control, panel,
   manager, `BottomArea`, and input-owner tests first; then typecheck, build,
   and the full unit suite because the input owner and session control port are
   shared. If implementation touches the run loop, provider bridge, or
   provider event plumbing, also run `pnpm test:provider-black-box`.

## Non-goals

- Proving that a remote model is "thinking" or that a silent process is hung.
- Restarting, retrying, or silently replacing a background task.
- Writing full provider or shell transcript logs into the UI state.
- Sending an observation-only task-manager view to the main agent.

## Acceptance criteria

- A user can tell why every live task is believed to be active or waiting, and
  when activity was last observed.
- A quiet live task is called out without being reported as failed or hung.
- Approval waits are visibly distinct from provider/tool silence.
- Ctrl+G is the only manager shortcut shown and works exactly once per keypress
  under the existing input-owner priority model.
- Existing per-item stop, completion notification, transfer, and retained-task
  behavior remain intact.
