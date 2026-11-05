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

A decorated request's notice is recorded on its `turn_started`, and Session applies it again to the same
message whenever it builds a later request, as legacy keeps it in history. Stored history stays raw, and the
continuity checkpoint keeps matching the decorated prefix.

A Session-admitted steer stays pending until the next request boundary. It never
aborts an in-flight physical response. Tool turns admit it before the next model
request; a plain-text response settles first and the pending steer starts the next
turn. This preserves the full response and its continuity before new input.

For a cancelled `ask_user` whose result is persisted locally but intentionally not
sent in the legacy continuation, Session calls `skipCancelledQuestion` before
starting the next user turn. It advances a checkpoint only for an exact history
prefix whose added items are exactly the outstanding tool results, one of them the
`ask_user` no-answer result. Any mismatch leaves the normal tool-debt guard unchanged.

Root calls of one response go through legacy's approval batch first
(`turn-tool-batch.ts`): questions, approval prompts and policy-approved calls that
legacy stages are decided in order, only the last decision of each pass applies, and
calls run in order up to the first undecided one. A question re-asked this way is the
legacy behaviour, not a bug to fix here. Escape on an approval prompt cancels the
turn; Session then drops the calls that never started (call and result) like legacy.
