# Canonical direct event projection

`server-events.ts` projects accepted direct `WireEvent`s into the pinned
agent-wire vocabulary. It does not admit commands, open storage or advance turns.

- `encodeCanonicalEvent(event, interactions, context)` returns zero or one v1
  envelope. It requires the original positive durable cursor and accepted
  timestamp when a candidate exists; it never manufactures either.
- `canonicalCandidate(event, interactions, context)` projects the payload without
  an envelope. `server-wire-v2.ts` reuses it inside its own accepted/live batching
  rules; null means no pinned public representation for that update.
- `canonicalCommandMessageCandidates(event)` returns every actual command display
  from a tool result for v2 batching. The v1 projection still refuses multiple
  displays sharing one numeric-ID boundary.
- `CanonicalEventContext.task` is immutable accepted task evidence at the replay
  cut, not a latest-task lookup. The candidate/context types remain exported by
  `server-events.ts`.

`server-task-events.ts` owns task lifecycle candidates and validation of accepted
parent/role identity for task-scoped events. Child turn boundaries are not task
settlement. Missing result/output/count evidence must not become blank success
or guessed lifecycle metadata.

`server-event-values.ts` owns shared pinned-value sanitization, required turn
identity and the typed `event_envelope_unavailable` refusal. Unsupported accepted
semantics fail with reload-required HTTP 503 rather than silently publishing
invented evidence. These are projection constraints, not execution limits.

Nested tool/retry projection remains in `server-events.ts` to reuse the root
payload rules without a circular dependency or another lifecycle owner. v1/v2
activation and browser/BFF compatibility remain separate transport contracts.

Root ESLint lints `src/` with the root TypeScript project, which includes these
files.
