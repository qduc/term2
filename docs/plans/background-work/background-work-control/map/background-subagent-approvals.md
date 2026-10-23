# Background subagent approvals

## Decision

A foreground subagent remains approval-capable after transfer. The same live child execution pauses under its session-owned lease, which retains the child `ApplicationRunLoop`, opaque `ContinuationHandle`, pending interruption batch, approval ledger, controller, traffic context, budget slot, evidence, and settlement promise.

The session owns a background approval queue and exposes a narrow snapshot/subscribe/resolve port. Each queued request has a stable run ID, tool-call ID, and interaction generation. Ink presents one request at a time and sends approve, reject, or rejection-reason decisions back through that port. The lease applies the decision to its retained child handle and calls `continueRunStream()` on the same child loop. Repeated approvals remain under the same lease until terminal settlement.

The root conversation's `ApprovalState` and `TurnCoordinator.continueAfterApproval()` are not reused as execution owners. They hold the root turn's singleton continuation and queue lifecycle; inserting a child continuation there could resume the wrong run or keep the root turn parked after its original `run_subagent` tool call already returned a running handle.

Presentation may reuse `ApprovalPrompt`, and decision classification should reuse or extract the policy currently owned by `services/approval/`. Visual reuse must not duplicate denied-read, folder-read, Docker-host-control, rejection, or stale-interaction semantics in React.

## State and ownership

```text
foreground_running
  |-- settles --------------------------> foreground_terminal
  |-- transfer succeeds ---------------> background_running
  |                                        |-- approval requested --> background_awaiting_approval
  |                                        |                              |-- resolve --> background_running
  |                                        |                              `-- stop ----> cancelling
  |                                        |-- stop --------------------> cancelling
  |                                        `-- settles -----------------> background_terminal
  `-- transfer fails -------------------> foreground_running
```

- Adoption validates registry capacity and lifetime before detaching the foreground parent-abort forwarder or changing event routing.
- The foreground `run_subagent` tool result resolves exactly once: terminal structured result when never transferred, or `{runId,status:"running"}` after successful adoption.
- Completion after adoption is delivered only through the durable background lifecycle/notification path.
- A parent-turn abort cancels before transfer and does not cancel after transfer. Per-run stop, global interrupt, disposal, and shutdown continue to cancel the adopted controller.
- An approval that races adoption is retained by the lease. Foreground ownership handles it if adoption loses; the background approval queue handles it if adoption wins.
- The acquired execution-budget slot and provider/cost state remain live until final settlement and release exactly once.

## Required validation

- One execution, stable run ID and provider-history key, one root tool result, and one terminal event.
- Transfer versus parent abort, completion, approval pause, capacity rejection, registry disposal, and shutdown.
- Approve, reject with reason, repeated approval, stop while paused, and stale decision rejection.
- Denied-read, folder-read, and Docker-host-control decisions preserve existing session capability semantics.
- Foreground events before adoption and persistent background events after adoption, with no fake completion or lost transition.
- Deterministic provider black-box coverage for root tool-result pairing, child continuation, later action/completion notification, and shipped-CLI approval input.

## Rejected alternatives

- **Cancel and restart in background** — duplicates provider work and may repeat mutating side effects.
- **Transfer only when no approval is currently pending** — a future tool can require approval after the UI has already promised a successful move.
- **Reuse the root pending approval unchanged** — resumes the wrong lifecycle owner and couples background work to root queue/turn state.
- **Treat approval as failure after transfer** — changes the foreground tool contract after ownership moves and can strand partially completed work.
