# Queued input across session rollover

The queue-through-rollover repair landed in `eee14caae`. See the
[rollover handoff contract](../../plans/sessions/session-rollover-handoff.md)
for the current lifecycle.

Queued submissions used to veto rollover even though the settled foreground
turn could safely yield to a successor. Allowing the transition required
preserving both the executable queue and the journal ownership of already
accepted messages. Keeping only the executable queue made live delivery appear
correct while a flushed successor log lost those inputs on replay.

The repair transfers the accepted user-message snapshots at successor briefing
acceptance, after the briefing record and before newer submissions received
during the briefing. Transfer at queue start was too late because newer messages
could already have journal records. The pending entry owns the full snapshot,
including edits and skills. Queue start updates the projection. A steer still
awaiting settlement keeps its admission callback as the journal owner.

## Historical verification

The first candidate exercised the runtime queue and sidecar but omitted the real
journal writer. A later repair added writer rotation, flush, replay and raw
user-message counts so projection deduplication could not conceal duplicate
records. The unchanged reviewer probe passed three cases, and the expanded
author runner passed sixteen. Those checks exercised normal flush and replay.
They did not establish atomicity across process loss and separate journal and
queue sidecar files.

The [original reports and runner](https://github.com/qduc/term2/tree/c455d16c56dfa1d46664c0b3183873100942bf65/docs/experiments/rollover-queue) use the pre-rewrite
hook and journal layout. [Archived raw captures](https://github.com/qduc/term2/tree/v1.3.0/docs/experiments/rollover-queue) are tied
to that revision. The durable test lesson is to verify outgoing dispatch and
the successor's durable log together, including record order and raw counts.
