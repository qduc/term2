# Native display observations

The native `Fact` vocabulary separates provider history from public display.
`transcript_message` observes one message `{id, role, content, presentation?}`;
`role` is user, assistant, system or tool. Optional outer `turnId` correlates the
observation without admitting a turn. `presentation` is a readonly JSON object
for original sender, usage, approval, command or subagent descriptors. It is
display data, not a tool execution, approval grant or provider instruction, and
does not depend on a legacy message schema or reader.

`reduceDirectFact` upserts observations by message ID at the first timeline slot.
`DirectProjection` emits ordinary message frames; native snapshots, the wire
reducer and TUI message adapter retain presentation without interpreting it as
authority. The TUI keeps the actual role (including system/tool); metadata need
not be rendered to be retained. Provider `replay` explicitly ignores observations.

`turn_started.display: false` suppresses derived input messages only. Admission,
active-turn state and provider input are unchanged. `item.display: false`
suppresses that item's derived message/reasoning/tool display only, not provider
history, context or tool settlement. Neither flag suppresses other facts (such
as text deltas or physical tool audit). Absent flags keep existing behavior.

`history_replaced.retainTranscript: true` replaces provider context while leaving
the current public messages, drafts and timeline intact. Without it, the existing
history-based public pruning remains in force, including retry/rewind behavior.
This is an explicit per-replacement choice, not a new compaction policy.

Failure lesson: checking only current message/tool arrays missed hidden provider
content in recovered final-window items and records. Item display suppression also
applies to that public projection, not to provider replay, usage/costs or physical
tool audit. A shared ID is not permission to replace an explicit transcript
observation with provider text or role: default history replacement prunes those
observations by retained ID only. Ephemeral message provenance distinguishes them
from ordinary derived messages, whose retry refresh behavior remains unchanged.

Observed text uses the ordinary version-2 same-turn payload codec, including
presentation strings. No reference kind or exclusion is added. Correlated
observations and hidden provider facts can share one physical body; observations
without turn correlation remain literal. Existing malformed, future and
cross-turn references still fail decoding before schema validation.

Native `turn_started.persistentNotice` prefixes the first admitted user message in
provider replay while preserving the raw queue payload. Cancellation notices use
this field and therefore survive later requests and reopening.

Native `turn_started.requestNotice` stores the resolved request-only notice separately
from raw input. Retry may attach it to the latest retained user-shaped input only
when the recorded and current modes match; this includes silent background turns.
It is not a display message. Persistence means the notice is retained in the
conversation log, even though it is absent from the user's input and transcript.

The initial runtime notice is queued once rather than copied into each turn's
fallback request. A retry consumes an identical pending notice; if a saved notice
also contains different request-specific text, that equality check can leave the
profile notice pending for the next input. The raw-input/notice split is necessary:
reconstructing only raw history on retry previously lost the original mode notice.

A `text_delta` with `withdrawn: true` removes the failed attempt from provider
replay but ends only its live draft in `reduceDirectFact`; the accepted display
message and timeline slot remain. Derived `presentation.withdrawn: true` marks
that display-only attempt for both native snapshots and ordinary wire message
updates. It is not a stopped-turn notice or a completed final answer, including
a successful retry that returns no text. The existing withdrawal fact, not new
persisted metadata, reconstructs this provenance on reopen. Headless answer
finalization, public turn results and nested completion adapters exclude this
message update; nested progress keeps the already-observed deltas. This follows the [#143 coordinator ruling](https://github.com/qduc/term2/issues/143#issuecomment-6650991397):
a quiet retry does not erase text the user saw or feed it back to the model.
The next attempt has a different model-step draft ID, so its final message does
not overwrite the failed attempt's display slot. Snapshot synchronization and
reopening must retain the same display, not silently prune it after live deltas.
This does not change retry eligibility or terminal-partial provider-history rules
from [approved M1 D7](https://github.com/qduc/term2/issues/76#issuecomment-6541016291).

A cumulative PTY transcript can pass while a later redraw removes the text.
The Responses quiet-retry fixture holds its successful terminal frame until the
latest complete render shows both attempts. After settlement, retained rows may
move into Ink Static scrollback rather than each redraw. A fresh CLI resume
checks retained display; retry/follow-up model inputs and the log separately
prove exclusion and durable withdrawal.
