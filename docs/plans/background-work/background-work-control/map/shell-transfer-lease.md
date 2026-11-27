# Shell transfer lease

## Decision

Make root agent shell execution start under a mutable, session-owned foreground lease. `BackgroundShellRegistry` can atomically adopt that lease while the command is still running. Adoption changes ownership and visibility, not the process.

Direct Shell Mode remains separate: it bypasses `AgentClient`, has no signal or job identity, supports SSH, and needs its own lease refactor before it can offer the same action.

## State machine

```text
foreground running ── settles ──> foreground settled
        │
        └─ move requested ─> transferred/background running
                                  │
                                  ├─ stop requested ─> cancelling ─> cancelled
                                  └─ settles ─────────> completed/failed/timed_out
```

Transfer validates capacity and registry lifetime before changing anything. It then removes the foreground-parent abort forwarder, inserts a background job record backed by the same controller and settlement promise, emits `background_shell_started`, and resolves the original tool call with `{jobId,status:"running"}`. A failed transfer leaves the foreground lease untouched.

## Ownership rules

- The lease owns one controller, one process promise, and one cleanup callback.
- Before transfer, the run loop's `ToolInvocationContext.signal` forwards abort into the lease controller.
- After transfer, the parent forwarder is removed. Per-job cancel, global interrupt, disposal, and shutdown abort the same controller through the registry.
- Sandbox and Docker cleanup run exactly once after process settlement, never when the foreground tool call returns its background handle.
- The foreground logger correlation is restored when transfer succeeds; later overlapping logs carry the lease correlation explicitly.
- `BackgroundShellRegistry.list()` and lifecycle events expose the lease only after adoption.

## Required tests

- Registry adoption preserves ID/start time and emits one start plus one terminal event.
- Capacity/disposal/race failures leave foreground ownership intact.
- Normal foreground completion remains unchanged and is cancelled by turn abort.
- After transfer, turn abort does not kill the job; per-job cancel and session shutdown do.
- The command executes once; cleanup executes once; the original call ID receives exactly one tool result containing the job ID.
- AgentClient/session integration proves the control notification reaches the next request boundary and the ordinary terminal notification still follows.
- Run `pnpm test:provider-black-box`; add a deterministic shipped-path scenario if the tool-result timing cannot be covered by existing session cases.

## Territory finding

`ApplicationRunLoop` passes its segment signal as `ToolInvocationContext.signal`, but invokes tool `execute` with details containing only the tool-call ID. Shell currently reads `details.signal`, so foreground agent shell has no effective run-loop cancellation. The lease must consume the typed tool context and tests must pin cancellation both before and after transfer.

## Automatic handoff (`shell.foregroundHandoffMs`)

The same transfer also runs without a person. When a model's own `shell` call is
still running after `shell.foregroundHandoffMs` (default 60 s, 0 = off), the
Session's shell-task port (`scheduleHandoff` in `src/session/shell-tasks.ts`)
calls `moveToBackground` on it. The process, controller, output and cleanup are
the ones above; the call's timeout is not extended, so a finite `timeout_ms` or
`shell.timeout` still ends it. The tool result adds `message` and `next`, saying
the job's exit will wake the session.

Why: in the waiting experiment, A1 prompt guidance still left a model running a
140 s suite in the foreground, blocking the turn. Elapsed time is only a proxy
for "this should be waited on", so the action is the least destructive one
available: change who waits, never kill or restart.

Who moved it is recorded: the handoff writes `task_backgrounded` with
`by: 'handoff'` (older logs and a person's move have no `by`). The Session's
user-control notice ("The user moved a foreground shell…") is written only for a
person's move; the handoff answers in the call's own tool result. The first
version omitted this and told the model the user had moved its command (found by
the independent verifier).

The handoff waits while a sandbox network prompt for the command is open
(re-checked every second): firing then would dispose the prompt's handler and
deny the destination on the person's behalf. It is dropped once the process has
exited, so post-exit cleanup is never reported as "still running". A moved
sandboxed command keeps the process-wide sandbox lease, as an explicit
background job does, so the result says other sandboxed commands wait for it.
The handoff is logged (`Shell foreground handed off to background`, with job id,
threshold and whether it was sandboxed).

Scope: root sessions with a background registry only. Subagents get no registry,
headless runs have no background jobs, and a call made by a `run_code` script is
never handed off (`isScriptedToolCall`), because the script is awaiting the
output. A command that finishes first returns normally. Covered by the
`foreground handoff` cases in `tests/tools/system/run-code/shell.integration.test.ts`
and by `tests/session/conversation/shell-handoff-notice.integration.test.ts`.
Rollback: set the setting to 0, or revert the one `handoffAfterMs` line in `shell.ts`.
