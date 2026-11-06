# Session validation and replay boundaries

`log-facts.ts` dispatches fact families and owns the shared error envelope.
`log-fact-native-schemas.ts` owns native fact-schema acceptance. Queue, context,
command, notification, and configuration facts retain their existing parsers.

Validation is intentionally lossless: accepted payloads are not normalized,
unknown vocabulary is rejected, and nested branch/task interaction facts recurse
through the same dispatch. In particular, execution IDs remain tied to tool-call
occurrences; replay must not identify an occurrence by provider ID, argument
hash, or a duplicated call ID alone.

`replay.ts` remains the pure projection boundary. It returns recovery facts in
append order rather than writing or dispatching them: root tool settlement,
interaction/budget closure, then interrupted terminal; branch recovery remains
wrapped in its recorded branch identity. Missing results remain outcome-unknown,
never evidence that an effect did not occur.

Terminal failures retain the final attempt's unsuperseded text deltas. Reopened
cancellations retain those fragments too, without changing the live policy that
drops the unfinished model step or the separate recovery rules for tool calls.
This is the resumed-provider-history contract in [M1 D7 and the R4/R5 acceptance
rows](https://github.com/qduc/term2/issues/76#issuecomment-6541016291), not a claim
that a partial response completed. `TurnModel.run` must not withdraw text merely
because recovery stops: that erased the truncated stream's final attempt before
replay could retain it. `settleCancelledReplayStep` restores only the surviving
delta slot on reopen, including when a cached fold was first projected live.

The same policy applies to nested turns. Later shared-role launches inherit a
failed run's unsuperseded partial alongside its accepted assistant and tool
history. Retention does not change the failed outcome or the parent's failure
notification.

An actual retry's `withdrawn: true` marker remains authoritative. It must not be
reversed to repair terminal text loss, and an accepted assistant item still
supersedes its deltas. [The retry-screen parity
decision](https://github.com/qduc/term2/issues/143#issuecomment-6650991397) concerns
showing provisional output while keeping it out of model history; it does not
authorize withdrawing an unretried terminal attempt. Compare follow-up model
input as well as stdout when diagnosing these two independent behaviors.

Personal-memory snapshots must materialize before their associated unchanged
human item, just as `planDirectHumanContext` does during live admission. Match
by admission ID whether the snapshot fact or human slot arrives first, and attach
only once. Inserting after the human instead preserves the text but changes the
provider prefix on reopen; the original personal-memory black-box cases compare
the live prefix with actual resumed requests to detect this drift.

`captureDirectCommandHistory` depends on this ordering: a personal snapshot is
preceding context, not the admission's trailing retry boundary. With no following
summary/provider input, that boundary stays on the human item. Pointing it at the
preceding snapshot makes `admissionBoundaries` reject rewind/retry commands live
and after reopen. Retry-turn keeps the snapshot and human together; rewind removes
the human but retains the preceding snapshot, consistent with the retained memory
comparison state so the next unchanged admission does not lose context.
