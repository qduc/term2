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
