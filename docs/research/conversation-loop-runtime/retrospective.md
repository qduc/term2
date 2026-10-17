# Lifetime changes exposed two old assumptions

Two defects were found before integration while replacing reconstruction with
retained operations. Neither is recorded as an escaped defect.

`AgentClient.continueRunStream` used to abort the previous segment before building
its replacement. With an actual suspended loop, that abort destroyed the operation
being resumed. The first provider black-box run failed at stateless-provider
approval with `Application turn is not waiting for continuation`. Reconnection now
cleans up the other client work without aborting the retained application loop.
The full provider suite then passed twice. Sibling audit: fresh `startStream` and
explicit `abort` still call `abortSegment`; continuation alone preserves it.

The first root observer wrapper retained its generator after an observer returned
early. Independent verification reproduced a blocked successor turn and missing
underlying generator finalization. `#observeTurn` now closes its task in `finally`
unless it deliberately returned a waiting approval view. The same probe passed
after the fix. Sibling audit: terminal completion, thrown errors and abandoned
observers all use that cleanup; approval views alone retain the frame;
`abortLiveRun` explicitly closes a waiting frame and still awaits existing stop
observers rather than manufacturing physical-stop proof.

The shared cause was changing the lifetime of an operation while retaining
cleanup assumptions built for disposable segments. The durable prevention is the
separation in source: a stream is an observation view, the async task owns the
operation, and reconnecting a view cannot abort that operation. The retained
provider black-box journey exercises sequential manual reconnection, retraction,
release and cancellation through the shipped CLI. Independent evidence also
records the temporary observer red/green probe; no permanent unit tests were added.

A further source audit kept later approval metadata and per-decision policy
refreshing inside the retained frame. Retention preserves accounting; it does not
freeze new decision inputs or public projections.
