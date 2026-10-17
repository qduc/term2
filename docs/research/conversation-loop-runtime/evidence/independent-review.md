# Independent runtime verification

Verdict: **accept** for the runtime sources identified in `independent-hashes.txt`.
The verifier did not implement or edit production runtime code. It added one real
built-CLI regression scenario and challenged the control-flow and ownership claims.

## Evidence executed independently

Command (three successful runs; the final run followed the final rebuild):

```sh
NODE_ENV=test pnpm exec vitest run --config vitest.provider-black-box.config.ts scripts/provider-black-box/conversation-loop.blackbox.ts --reporter=verbose
```

The first two journeys passed in 7.11 seconds and 6.14 seconds. After the final
runtime changes and rebuild, the exact-source journey passed in 8.44 seconds
(8.83 seconds total). Raw outputs are `independent-cli.log`,
`independent-cli-repeat.log`, and `independent-cli-final.log`. The final source
and built-output hashes are retained alongside this report.

This launches the shipped CLI in an isolated PTY, drives actual composer and
approval controls, sends requests through the production provider registry and
HTTP Responses adapter to a loopback SSE server, and approves only harmless `pwd`
calls in its disposable workspace. Assertions establish:

- An active-turn steer can be edited through Up/e before admission; the next
  provider request contains the edited payload and excludes the original.
- Another pending steer can be retracted through Up/d; it reaches neither the
  next request nor a later fallback turn.
- Two sequential manually approved tool rounds complete one turn. Each result
  appears once with the correct call identity and response-chain anchor.
- A steer released by a normal no-tools answer becomes exactly one follow-up
  request and the CLI returns to idle afterwards.
- Ctrl+C while a steer waits closes the active HTTP execution. The pending steer
  does not become a fallback, and new input completes with a fresh provider chain.

The original harness draft incorrectly treated a burst of Backspaces as multiple
key events and used an old selection hint as readiness. Those harness mistakes
were corrected with exact composer acknowledgements and fresh rendered selection
markers before making behavioral claims.

## Findings resolved during implementation

1. The first root generator wrapper stranded its inner operation if an observer
   returned early. A temporary public-method probe showed the inner `finally`
   did not run and the next turn failed with `A conversation turn is already active`.
   The same probe after the `#observeTurn` cleanup change verified the inner
   `finally` ran and the next turn started. The temporary probe was removed; the runnable reproduction and red/green observations
   are retained in `observer-abandonment-probe.md`. The final built version was
   independently probed again and passed.
2. The first root wrapper only added an observer protocol around existing
   continuation reconstruction. The revision removed `#projectOperation` and
   `#executeContinuationBodyImpl`, and now retains `executeContinuationAttempt`
   across manual decisions. The shared model–tool cycle is one `#runTurn`.
3. Retaining that continuation operation initially omitted refreshing emitted-ID,
   source and input-mode metadata after a manual gate. `#answerPendingApproval`
   now refreshes those facts while retaining retry and cumulative accounting.
4. A later manual decision must also refresh its optional approval policy. The
   final source propagates each decision policy and restores the usual default
   when it is omitted, matching the previous public-call behavior. This detail
   was inspected; arbitrary custom policies are outside the focused CLI scenario.

A supplementary temporary direct-run-loop probe also passed repeated approvals,
steering during approval, double/terminal reconnect rejection, and abort while
paused without tool dispatch. This was supporting control-flow evidence, not the
user-workflow acceptance evidence above; its temporary file was removed.

## Source inspection

The recognizable cycle in `ApplicationRunLoop.#runTurn` prepares a request,
asks the model, accepts response facts, executes the ordered tool plan and makes
an explicit no-tools terminal decision. Safe transport attempts repeat inside
`#askModel`; helpers do not secretly start another model round.

Approval and budget gates suspend the same live computation. Per-segment streams
are observer views; reconnect refreshes their queue, signal and tool context.
Abort removes resumability synchronously, and old-generation settlement cannot
settle the successor's mailbox. Root workflow retains its own reconciliation
operation while approvals are answered; its metadata is not an alternate model
program counter.

The adapter now owns one submission record through steering, edits, retraction
and released-steer fallback. The orchestrator's edited/retracted fallback stores
and resubmission decisions are gone. Queue ordering/durability and mailbox
request-boundary timing remain distinct policy/projection responsibilities.
The final cancellation epoch check rejects an unadmitted released steer after
Stop, while preserving an already admitted fact; record identity still rejects
explicit retraction. Raw skill-bearing turns stay on the submission record and expansion happens at
admission/dispatch; inspection found no double expansion in the UI route.

The implementer's final provider log was also inspected: 22 files passed, 202
cases passed, one skipped. Its wider cases cover provider failures, restart,
compaction, background work, and provider lifecycle behavior. Those results are
implementer-run evidence, not additional independently rerun scenarios.

## Limits

This is deterministic shipped-CLI evidence, not a live commercial-provider run
or a human comprehension study. The focused independent scenario does not
exercise every rich skill/image payload, every post-execution policy, persistence
failure, gateway lease or subprocess cancellation race. Existing production
physical-stop proof and recovery policies remain necessary; HTTP socket closure
alone does not prove arbitrary child-process quiescence. The architecture is
simpler at its central flow and submission ownership boundaries, not a deletion
of provider, journal, queue or safety policy complexity. The implementer reports final static, integration/e2e and Codex network suites
passing; those wider results are owned and retained by the implementer. No
concrete must-fix correctness issue remained in the inspected final diff.
