# Turn model and tool boundaries

These implementation modules now live in `@qduc/agent-core`
(qduc/agent-runtime `packages/core/src/engine`). `src/engine` re-exports only public
package contracts and continuity/history helpers. Session composes turn entry
points with Term2 policy.

`TurnModel` owns the root physical request lifecycle: steering, request preparation,
continuity/recovery, root stream acceptance and the native model-call boundary. Its
public constructor and `run`, `compact`, and `clear` methods are the engine-facing
contract used by `turn.ts`.

Only a selected recovery retry can carry a live retry notice. A denied replay
keeps its terminal error and exhaustion notice without announcing another
dispatch. Publishing the retry notice before checking the stop decision previously
showed a retry that could not run after the shared recovery budget refused it.

`TurnCompaction` owns a private compaction proposal and its auxiliary summary/native
requests. It receives the root-owned auxiliary preparation callback so summary work
uses the same model-step, budget, recovery and dispatch boundary without gaining
root tool authority. A replacement changes history only after the `history_replaced`
event is accepted; only then does it clear continuity and retain compaction state.

Provider-prefix selection treats a summary as a replacement only when its `replaces`
list is nonempty. Budget evidence, goal-repair reminders and mode notices use empty
lists: they add context without dropping prior user input or completed tool evidence.
Item IDs are identities, not replacement authority; even a turn ID beginning with
`compact_` can produce these ordinary notices. Local compaction installs its entire
checkpoint and retained tail through `history_replaced`, so an empty-replaces
checkpoint needs no ID-based fallback on live requests or replay. Native OpenAI
opaque compaction items retain their separate provider-owned replacement boundary.

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

For a cancelled `ask_user`, Session calls `chainCancelledQuestion` before starting
the next user turn. When the history added since the checkpoint is exactly the
outstanding tool results, one of them the `ask_user` no-answer result, that turn
may chain from the question's response and sends those results ahead of its own
input. Legacy chained without them and the Responses API refused the request with
"No tool output found" (#150 item 10). Any mismatch leaves the normal rule: a new
turn never inherits tool debt, so it sends full history instead.

Root calls of one response go through legacy's approval batch first
(`turn-tool-batch.ts`): questions, approval prompts and policy-approved calls that
legacy stages are decided in order, only the last decision of each pass applies, and
calls run in order up to the first undecided one. A question re-asked this way is the
legacy behaviour, not a bug to fix here. Escape on an approval prompt cancels the
turn; Session then drops the calls that never started (call and result) like legacy.
