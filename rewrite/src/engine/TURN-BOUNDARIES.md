# Turn model and tool boundaries

`TurnModel` owns the root physical request lifecycle: steering, request preparation,
continuity/recovery, root stream acceptance and the native model-call boundary. Its
public constructor and `run`, `compact`, and `clear` methods are the engine-facing
contract used by `turn.ts`.

`TurnCompaction` owns a private compaction proposal and its auxiliary summary/native
requests. It receives the root-owned auxiliary preparation callback so summary work
uses the same model-step, budget, recovery and dispatch boundary without gaining
root tool authority. A replacement changes history only after the `history_replaced`
event is accepted; only then does it clear continuity and retain compaction state.

`TurnTools` owns provider-order scheduling, execution admission and selected-stop
policy. `TurnToolInteractions` owns only execution-scoped interaction publication,
durable readiness and matching answer waits. It cannot select or start work; that
policy remains in `TurnTools`, preserving selected-stop matching and ordered result
publication.

After a decorated request commits successfully, Session may reconcile a continuity
checkpoint to its raw durable input. `DirectContinuity.reconcilePrefix` only replaces
an exact sent prefix with the corresponding same-length, same-ID/type durable prefix;
otherwise it leaves the checkpoint unchanged. This preserves strict prefix matching
for subsequent response chaining without recording request-only decoration in history.

A Session-admitted steer wakes an active root request only after text has begun and
before any tool-call output is observed. It aborts that physical request, not the
turn; the accepted partial is finalized as an assistant item before the durable
queue boundary admits the steer, and the next request uses that history without a
continuity checkpoint for the interrupted response. A steer before text begins or
after tool-call output remains pending until the usual request boundary. This
keeps started tool calls and their results under the normal execution policy. The
text finalization matters to replay and to the TUI: leaving the partial as a live
draft would render it after the new user message even though it preceded it.
When a steer interrupts a recovery attempt, the next dispatch claims a fresh
physical recovery attempt; it never reuses the interrupted attempt's claim.
The existing finite recovery limit can still reject that continuation.
