# Turn lifetime cleanup

Preventable: yes. These defects were found in the uncommitted ownership migration,
before completion. The prior implementation is the comparison baseline f2a9ec8a.

Bug: a manually forwarded async generator did not propagate observer return to
the session adapter. The new task could keep streaming or waiting for approval,
leaving a successor blocked. A separate review found that Stop during session
recovery backoff had no whole-turn signal between stream views.

Root cause: the consumer's lifetime and the runtime's lifetime crossed a generator
boundary without closure propagation; stream cancellation was also being used
as a substitute for cancellation of the logical turn.

Fixed: TurnCoordinator's forwarding generator closes its delegate in finally.
Abandoned observation uses the same abortLiveRun cleanup as explicit Stop, which
rejects pending decisions and awaits completion. ApplicationRunLoop owns a turn
signal across preparation, streams, decisions and recovery; segment cleanup
cannot revoke it accidentally. A cancelled LiveRun skips its not-yet-started
consumer. No deadline or retry policy was changed.

Evidence: the independent verifier reverted only delegated-generator cleanup.
Both real public-session abandonment probes failed; restoring it made the
streaming, approval and actual post-execution-gate probes pass. Outputs and the
removed temporary probe are retained in evidence. The permanent built-CLI test
covers answer/cancel/successor behavior through PTY, HTTP and persisted history.

Structural prevention and sibling audit:

1. Representability: the root session protocol no longer accepts a live legacy
   handle that could create a second execution owner. Required prepare(signal)
   carries the runtime's cancellation authority to session preparation.
2. Single truth: the runtime owns logical cancellation; stream views derive
   signals. Session APIs resolve decisions rather than constructing new runs.
3. Boundary: forwarding closes its delegated iterator, and abort waits for the
   owned task. A pending answer is explicitly rejected on shutdown.
4. Coupling: initial, manual-approval and post-execution coordinator paths share
   #forwardOwned and the adapter's #observe cleanup; none implements its own
   execution restart.
5. Timing: consumer return can occur before completion or during a pending
   decision; Stop can occur before a segment exists. Both need logical lifetime.
6. Detection: ordinary final-response tests consume the iterator completely and
   miss early return; request-time cancellation tests miss between-view waits.
   Separate public-session source probes exercise those boundaries.
7. Automation: typecheck enforces the signal argument but cannot prove iterator
   cleanup. No new static guard was added; repository policy requires approval.
8. Siblings: start/continueAfterApproval/continueAfterPostExecuteApproval all use
   the shared forwarder; adapter initial/answer/postexecute all delegate observe;
   postexecute registry cancellation fail-closes its gates. Nested native waits
   retain their existing per-segment signal and resume closure.
9. Knowledge: the architecture docs now name one advancement owner and distinguish
   observation, task cancellation and physical stop proof.
10. Observability: defects were found during this task's independent review,
    before integration. The public probes inspect actual abort/successor behavior.
11. Origin: found during the uncommitted migration. Red/green mutation evidence
    isolates delegation cleanup against the new runtime. The entire old runtime
    was not rerun with these probes, so this does not establish whether an
    equivalent baseline defect existed or attribute it to an earlier task.

Limits: no finite suite proves every cancellation schedule. Existing execution
stop evidence remains authoritative; an aborted observer does not prove a child
process has stopped. No human comprehension improvement was measured.
