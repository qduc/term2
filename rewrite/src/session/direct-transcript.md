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

Observed text uses the ordinary version-2 same-turn payload codec, including
presentation strings. No reference kind or exclusion is added. Correlated
observations and hidden provider facts can share one physical body; observations
without turn correlation remain literal. Existing malformed, future and
cross-turn references still fail decoding before schema validation.
