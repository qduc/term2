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

## Historical source-session handle

`adopted/session-handle.ts#createLegacySessionHandleFactory` composes the historical
source-backed handle admitted by `LocalSessionStore`. It owns canonical restore,
paired settings/model forks, source runtime binding, foreground/network/goal
authorities and shutdown ordering. The `assembleEngine` callback is supplied by
the caller through `LegacyEngineOptions` / `LegacyEngineAssembly`; Session never
imports application-agent construction. Engine options, runtime options and
assembly are synchronous, and the bound client must exist before construction
returns. Failure preserves the original construction error while attempting
owned cleanup. This boundary does not assemble native direct Sessions.
