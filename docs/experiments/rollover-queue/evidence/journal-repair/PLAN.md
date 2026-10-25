# R1 repair contract and triage

R1 — ROUTE, must-fix: normal completed successor replay loses two delivered user
inputs. Reproduced unchanged reviewer fixture locally: exit 1, 1 failed / 2 passed.
No crash or unusual persistence failure is required. Original FIX_REPORT and
reviewer source/evidence stay immutable; work remains isolated and uncommitted.

Scope: preserve the live queue-through-rollover outcome while transferring the
journal ownership of pending inputs exactly once. Current real-writer-before-
identity ordering and ordinary same-session acceptance journaling stay unchanged.
No queue replacement, full-transcript replay, retry or cross-file transaction.

Mechanism cost: one private marker on an existing outstanding submission, set
only by the existing queue-preserving rollover reset, consumed at queued start.
The start reconstructs the latest user message from the already authoritative
queue input. Ordinary same-session records have no marker and are not appended
again. Existing pending-steer settlement already journals its latest input into
the current writer; replacing the outstanding entry at that boundary clears the
marker naturally. Retraction/failure removes the same entry, with no second index.

Alternatives: removing retained delivery violates the outcome; journaling every
queue start duplicates ordinary submissions; journaling all pending messages at
reset records them before the successor briefing rather than their start order.
A new session journal/retry/transaction subsystem adds mechanism without need.

Claims/checks: unchanged reviewer fixture must become 3/3 green. Strengthen its
raw user_message counts to distinguish one record from replay deduplication,
retain before/during rotation and during-briefing coverage, ordinary same-session
exactly-once and briefing cancellation/resume. Carry it into the retained runner
and rerun all 11 existing controls plus typecheck/static guards and focused
lint/format. Independent reviewer owns acceptance; no broad unrelated tiers.

## Adaptation observed in the same bounded R1 repair

The first start-time transfer restored the missing text but failed the unchanged
review assertion: input arriving during the briefing was already journaled before
older retained inputs started. That would reorder successor replay. Keep the
existing submission-time journal policy instead: journal the successor briefing,
then transfer marked accepted queue records before accepting newer input.

Final mechanism uses the existing outstanding entry's full UserMessage snapshot
instead of duplicated id/text fields; its external list projection is unchanged.
This retains edited display/skill metadata at transfer. Only `queued` entries
are marked by the queue-preserving reset; unsettled steers retain their existing
admission-callback journal owner. Markers are cleared immediately after transfer,
and ordinary queue start remains projection-only. Retraction removes the same
entry; there is no second retained index. No runtime queue/identity code changed.

Several local patch-anchor failures left an intermediate incomplete map edit;
the typecheck reported TS2353 and the fixture stayed red. Those failed checks and
outputs are retained, not called passing evidence. Checked exact anchors with
fail-fast shell sequencing completed the edit. The unmodified reviewer fixture
then passed 3/3 with typecheck exit 0. The expanded retained runner passed 16/16:
original 11 plus five real-writer/replay/raw-count/cancel/steer/edit/retract checks.
