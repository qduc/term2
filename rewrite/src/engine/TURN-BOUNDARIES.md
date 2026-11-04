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

A Session-admitted steer stays pending until the next request boundary. It never
aborts an in-flight physical response. Tool turns admit it before the next model
request; a plain-text response settles first and the pending steer starts the next
turn. This preserves the full response and its continuity before new input.

For a cancelled `ask_user` whose result is persisted locally but intentionally not
sent in the legacy continuation, Session may call `skipCancelledQuestion` before
starting the next user turn. It advances a checkpoint only for an exact history
prefix with one outstanding `ask_user` call and exactly its matching no-answer
result. Any mismatch leaves the normal outstanding-tool-debt guard unchanged.
