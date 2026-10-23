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
