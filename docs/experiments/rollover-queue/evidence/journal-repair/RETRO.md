# R1 retro: runtime transfer omitted journal ownership

Preventable: yes. Normal completion/flush, not crash recovery, lost accepted user
instructions from successor replay. Origin is the unaccepted queue-preserving
candidate in the original FIX_REPORT: retained executable/presentation ownership
crossed rollover, but submission-time journal ownership did not.

- Representability: a queued submission could retain text/stage without the full
  accepted UserMessage or its pending journal transfer. The same private entry
  now owns the full message snapshot and one rollover-only transfer marker.
- Single source: public outstanding id/text/stage is derived from that snapshot;
  there is no new parallel queue/journal index. Edits update that same snapshot.
- Boundary: writer rotation precedes identity commit; the existing successor
  briefing acceptance is the owner that transfers accepted queue records.
- Implicit coupling: queue start updates presentation only. It must not blindly
  append ordinary user records that submission already journaled.
- Wrong timing assumption: copying at queue start is too late: during-briefing
  input was already logged, reordering old input. Preserve acceptance-time policy:
  briefing record, retained records, then newer accepted records.
- Detection gap: the first runner had a real runtime and sidecar, but no journal
  writer in the hook harness. It could not establish completed-session replay.
  The retained runner now crosses writer rotation, flush and replay, with raw
  user_message counts so replay deduplication cannot hide duplicate records.
- Automation: typecheck/guards cannot establish cross-session journal ownership.
  The full-message entry plus one-shot marker enforce local ownership; retained
  real-writer fixture data/runner provide regression evidence, not a new CI tier.
- Siblings: ordinary initial logging and steer-settlement logging remain owners;
  unsettled steers are not marked. Queued starts remain projection-only. Rollover
  reset marks queued entries, ordinary clear removes them, retraction removes
  them, and editing retains current text/skill metadata. Controls cover ordinary
  queue/released steer, edited/retracted transfer and briefing cancel/resume.
- Knowledge: original report scoped the missing writer coverage but underestimated
  its consequence. R1 is a concrete author-verification rejection, not an escape
  after acceptance or a demand for power-loss transactions.
- Observability: raw writer records and restored user/history oracles reveal this
  loss in one bounded run; runtime outgoing requests alone did not.
- Origin/attribution: introduced by the current unaccepted retained-input change;
  no historical completed delivery or escaped-defect total is inferred.

Fixed: one production file (33 additions / 9 deletions versus frozen candidate),
with no queue/retry/transaction subsystem. The first at-start attempt and an
incomplete mechanical edit stayed red/failed typecheck and are retained. Final
unmodified reviewer probe is 3/3, expanded author runner 16/16, and affected
static/type/lint checks pass. Independent scoped recheck remains pending.

Design friction: the old minimal outstanding projection omitted journal payload.
Storing the existing UserMessage and deriving that same public projection is a
bounded reshape inside its owner; it avoids a second transfer cache and preserves
skill metadata and edits. No change to provider/run-loop/queue-controller policy.
