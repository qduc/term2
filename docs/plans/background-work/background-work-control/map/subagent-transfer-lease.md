# Subagent transfer lease

## Decision

A transferable foreground subagent must start under a session-owned lease. Calling `SubagentAsyncRegistry.startRun()` when the user clicks “put in background” is not a transfer: it creates a new `SubagentSession`, control object, runner, and provider execution, duplicating work and possible side effects.

The lease carries a stable run ID (normally the root tool-call ID), its own controller with a detachable parent-abort forwarder, role/task/start time, original provider traffic context, progress/evidence, settlement promise, and a one-shot resolver for the pending foreground tool result.

On a successful move, the controller detaches from the foreground turn, the async registry adopts the exact lease, bridge event routing switches to the persistent background sink, the original `run_subagent` call resolves once with `{runId,status:"running"}`, and normal async status/stop/result/retention/shutdown semantics take over. Failed adoption leaves foreground ownership unchanged.

## Approval blocker

`NestedSubagentRunner` can return an `interrupted` result when an inner tool needs approval, but it does not expose a resumable inner continuation handle. After the parent tool call has returned a background handle there is no foreground approval turn left to resume that nested execution.

There are two truthful choices:

- Build a common pause-capable lease and a background approval/resume UI, preserving the existing nested approval contract.
- Explicitly exclude approval-capable transfers. This is weaker than it sounds because whether a future tool will require approval is generally unknowable at transfer time; the run can still become stranded later.

This product decision remains open. No implementation may silently restart the subagent or report a transferred run while dropping its future approval path.

## Required tests

- One execution, one stable run ID, one original provider-history key, one foreground tool result.
- Parent abort cancels before transfer and does not cancel after transfer.
- Per-run stop, global interrupt, disposal, and shutdown settle the adopted lease.
- Foreground events switch to persistent background routing without a fake completion or duplicate terminal event.
- Capacity/disposal/settlement races roll back or settle under exactly one owner.
- A post-transfer nested approval has an explicit tested outcome before the feature is enabled.
- Provider black-box covers the root tool-call result pairing and subsequent main-agent control/completion notifications.
