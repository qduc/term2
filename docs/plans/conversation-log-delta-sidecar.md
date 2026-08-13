# Conversation log: move streaming deltas to a droppable sidecar

**Status: plan.** Awaiting review, then implementation.
**Owner:** qduc (implementation unassigned).
**Branch:** `delta-sidecar-log`, worktree `.worktrees/delta-sidecar-log`.

## Problem

`assistant_journal_delta` events dominate the conversation log and are dead
weight the moment their turn settles.

Measured on the author's own corpus (557 sessions, 593 MB, `~/Library/Application
Support/term2-nodejs/conversations`):

| Event type | Count | Share |
| --- | ---: | ---: |
| `assistant_journal_delta` | 1,171,452 | 91.5% |
| `assistant_journal_item` | 29,981 | 2.3% |
| everything else | ~79,000 | 6.2% |

The deltas are only ever read to reconstruct a turn that never produced a final
`assistant_turn` event — a crash or kill mid-stream.
`applyInterruptedTurnJournals` (`source/services/conversation/conversation-replay.ts:909`)
short-circuits on `if (journal.sawFinalTurn) continue;`, so once a turn settles
its deltas are unreachable by any code path. For a session that exits normally,
every delta it ever wrote is garbage.

**Event share is not byte share.** Deltas are 91.5% of events but individually
tiny, while tool results and assistant turns are large. Measured exactly over
the same corpus:

| Measure | Deltas | Total | Share |
| --- | ---: | ---: | ---: |
| Events | 1,171,452 | ~1,280,000 | **91.5%** |
| Bytes | 185 MB | 620 MB | **29.8%** |

Two user-facing costs, sized honestly:

- **Disk.** ~30% of the conversation store is unreadable bytes, growing without
  bound. Real but moderate — this is not a 10x disk win.
- **Analysis latency.** This is the larger effect. Any line-oriented pass over
  the corpus — `listConversations`
  (`source/services/conversation/conversation-persistence.ts:306`) reads each
  file in full to build one list entry — iterates ~12x more records than it
  needs, because cost there scales with line count, not bytes.

## Approach

Keep deltas out of the canonical log; write them to a per-session sidecar that
is deleted when the session closes cleanly.

- **`<sessionId>.jsonl`** — canonical. Every event *except*
  `assistant_journal_delta`. Unchanged filename, unchanged fsync policy.
- **`<sessionId>.deltas`** — sidecar. `assistant_journal_delta` only. Never
  fsync'd (these events are already excluded from `FSYNC_EVENTS`).

On clean close the sidecar is unlinked. On crash it survives and replay merges
it back.

### Why not mirror the whole stream into a second file

The obvious shape — write everything to a raw file, write a compacted copy
alongside, drop the raw one at session end — costs **two `fsyncSync` calls per
durable event**. `FSYNC_EVENTS` (`conversation-log-writer.ts:15`) covers
`tool_started`, `tool_result`, and `assistant_journal_item`, which together are
~64,000 events in the measured corpus. fsync is the expensive operation on the
write path, so mirroring taxes every turn to save disk later.

Splitting by event type instead means **each event is written exactly once** and
the fsync count is unchanged. The canonical file is compacted by construction
rather than by a later pass.

### Sequence numbers

Both files share the writer's single `#seq` counter, so the merge on recovery is
a sorted interleave with no ambiguity. The canonical file will contain **gaps**
in `seq` where deltas were routed to the sidecar.

Verified safe: nothing treats `seq` as contiguous. `conversation-decoder.ts:162`
reads it as a plain number with a `0` fallback; `conversation-replay.ts` uses it
only for ordering and for `watchId:seq` idempotency on background-shell firings
(line 742), which is unrelated to journal events. `readLogTailState`
(`conversation-log-writer.ts:104`) scans backward for the highest value, not a
count.

## Non-goals

- **No compaction of the 557 existing logs.** This plan changes the write path
  only. A migration pass over historical files is separate work and should not
  block this.
- **No change to what recovery produces.** A crashed session must replay to the
  same transcript it does today. This is a storage change, not a behavior change.
- **No `LOG_ENVELOPE_VERSION` bump.** The canonical file remains valid v3 — it is
  a subset. Readers must keep handling inline deltas regardless, because every
  existing file has them.
- **No change to the fsync policy or `FSYNC_EVENTS` membership.**
- **Not addressing** the `tool_result.status` instrumentation gap (all 14,746
  recorded results are `completed`) or the suspected `exit 0` discrepancy in
  shell output. Both were found during the same investigation and deserve their
  own plan; neither is a dependency here.

## Design details and hazards

### 1. Sidecar must not end in `.jsonl`

`listConversations` (`conversation-persistence.ts:306`) enumerates conversations
with `readdirSync(dir).filter((f) => f.endsWith('.jsonl'))`, then parses each
match as a session. The legacy-migration path (line 51) uses the same predicate.
A sidecar named `<id>.deltas.jsonl` would appear as a **phantom conversation in
the resume picker**.

Name it `<sessionId>.deltas`. Confirm no other `*.jsonl` glob exists over the
conversations directory.

### 2. Closing mid-turn must not delete live deltas

"Session end" is the wrong drop condition. If the user quits while a turn is
streaming, that turn is unsettled and its deltas are exactly what recovery
needs.

**A structural "last event was `assistant_turn`" test does not work.** Review
established that shutdown appends events after the final turn settles:
`conversationService.shutdown()` is awaited *before* `logWriter.close()`
(`source/cli.tsx:844-845`), and that shutdown awaits `backgroundShellSettlement`
and `backgroundSubagentSettlement` (`session-composition.ts:759-761`), each of
which can emit `background_shell_completed` / subagent lifecycle events. Most
real sessions would therefore end on a non-turn event, the rule would never
fire, and every sidecar would fall through to GC — defeating the optimization.

**Use an explicit settlement flag instead.** The writer keeps one private
boolean, updated in `append()` from event types it already sees:

| Event | `#hasUnsettledTurn` |
| --- | --- |
| `user_message` | `true` |
| `assistant_turn` | `false` |
| `undo` | `false` |
| `session_cleared` | `false` |
| anything else | unchanged |

`close()` drops the sidecar iff `#hasUnsettledTurn === false`. Trailing
background-shell and subagent events leave it untouched, so the common clean
exit collects the sidecar immediately.

This adds two lines of turn awareness to a writer that is otherwise
semantics-free. That is a real but small cost, and it is the minimum needed for
the drop to ever fire. Over-retention remains the failure direction: if the flag
is somehow stale-true, the sidecar survives and GC collects it.

### 2a. No check/unlink race

Review raised a race between the drop check and the `unlink`. It does not exist:
`append()` returns early when `#closed` is true (`conversation-log-writer.ts:330`),
and `close()` sets `#closed = true` as its first action (line 400). Ordering
close as **set `#closed` → read flag → unlink sidecar → release lock** makes the
check and the deletion observe the same state, because no further append can
land in between.

### 3. Recovery merges canonical + sidecar

Today replay reads one file. New rule:

- If `<id>.deltas` exists, read both and merge by `seq` before replay.
- Otherwise read the canonical file alone (the steady state, and every one of
  the 557 existing files).

Because the sidecar is never fsync'd, its tail may be short after a crash. That
is acceptable and matches today's durability contract: `assistant-turn-journal.ts:101`
already documents deltas as "non-critical and not fsync'd", with the final
`assistant_turn` and provider-backed items as the durable record. A truncated
sidecar degrades a recovered partial turn; it never corrupts a settled one.

### 4. Seq recovery must span both files — and this lands in step 2, not step 3

`readLogTailState` (`conversation-log-writer.ts:104`) takes a single `filePath`
and resumes numbering from the highest `seq` in it. With deltas relocated, the
high-water mark after a crash will *usually* live in the sidecar, since deltas
outnumber everything else ~10:1. Resume from `max(canonical, sidecar)` or the
writer reissues sequence numbers and breaks merge ordering.

Review is right that this cannot be deferred to the read-side step: the writer
computes `#seq` during `#initialize`, so **step 2 must widen
`readLogTailState` to span both files.** Shipping step 2 alone with
single-file recovery would corrupt seq ordering for any resumed session.

### 5. `rotate()` must move in lockstep

`rotate()` (`conversation-log-writer.ts:356`) closes the fd, releases the lock,
resets `#seq` to 0, and re-initializes under a new session id. Called from
`source/cli.tsx:818`. The sidecar must close and reopen with it, or the next
session's deltas append to the previous session's sidecar.

### 6. Orphaned sidecars need a GC

A killed process never reaches `close()`, so orphans need collecting.

**Correction — an earlier draft of this plan got the GC rule wrong.** It said to
collect sidecars with no held `<sessionId>.lock`. That is precisely backwards: a
sidecar with no held lock *is* the crash case, and its deltas are exactly what
`--resume` needs to rebuild the interrupted turn. Lock-keyed GC would delete the
data the sidecar exists to preserve.

The implemented rule (`collectOrphanedDeltaSidecars`) keys on the canonical log
instead: **delete a sidecar only when its `<sessionId>.jsonl` no longer exists.**
Such a sidecar can never be resumed, so it is unambiguous garbage. Sidecars for
still-resumable crashed sessions are left alone and are dropped by the next
clean `close()` of that session.

Accumulation risk is low by construction: a sidecar is retained only when a
session ends with an unsettled turn, i.e. a crash mid-stream.

**Open policy question, deliberately not decided here:** should sidecars for
crashed sessions also expire after some retention window (say 30 days), on the
grounds that nobody resumes a months-old interrupted turn? That trades a bounded
disk guarantee against silently discarding recoverable state, and it is the
user's call, not an implementation detail. Orphan-only GC ships now because it
cannot lose data.

Order the operations in `close()` as **unlink sidecar → release lock**, not the
reverse. Review flagged a window where a crash between `releaseLock` and
`unlinkSync` leaves an orphan the GC cannot distinguish from a live sidecar;
unlinking first removes that window entirely, with no marker file needed.

Note the existing lock is already stale-prone after a kill (`acquireLock` throws
`LockConflictError` on `EEXIST` with no staleness check). A crash mid-close
therefore leaves both a stale lock and a sidecar. That is a **pre-existing**
condition this plan neither fixes nor worsens. Do not widen scope to fix it
here; GC should be read-only with respect to lock semantics, and should treat
"lock present" as "skip".

### 7. `forkConversation` copies by id

`forkConversation` (`conversation-persistence.ts:403`) copies
`<sourceId>.jsonl` to `<newId>.jsonl`. Forking a session with a live sidecar
would silently drop its unsettled deltas.

**Decision: do not copy the sidecar.** A fork of a half-streamed turn is not a
coherent artifact, and copying would hand the new session deltas whose `seq`
numbering belongs to the source. Forking carries settled turns only. This is now
acceptance criterion 10 so the behavior is asserted rather than assumed.

### 8. Single writer, single journal — no concurrency to reason about

Review asked whether SSH sessions or subagents can produce concurrent writers or
sidecars. They cannot, and this is worth recording so it is not re-litigated:

- `createConversationLogWriter` has exactly **one** call site,
  `source/cli.tsx:743`. One process, one writer.
- `AssistantTurnJournal` is constructed exactly once,
  `session-composition.ts:429`, for the main session.
- Subagents append lifecycle events (`subagent_started`, `subagent_completed`, …)
  to the parent's log but **never emit `assistant_journal_delta`** — they have no
  journal of their own. So the sidecar only ever holds main-agent deltas.
- SSH mode runs the app locally and executes remotely; the log is local, so the
  per-session `<sessionId>.lock` remains sufficient.

## Acceptance criteria

1. A session that runs and exits cleanly leaves **exactly one** file,
   `<sessionId>.jsonl`, containing **zero** `assistant_journal_delta` events.
2. That file replays to a byte-identical projected state versus today's log for
   the same event stream.
3. A session killed mid-stream leaves both files, and replay reconstructs the
   partial turn identically to today.
4. A session killed after a turn settles but before exit replays identically,
   whether or not the sidecar survived.
5. The resume picker lists the same conversations as before — no sidecar
   appears as an entry.
6. `rotate()` produces a fresh sidecar bound to the new session id; the previous
   sidecar is closed and dropped per rule (2).
7. Startup GC removes sidecars whose canonical log is gone, and removes none
   whose canonical log survives — including sidecars from crashed sessions that
   are still resumable.
8. fsync call count per turn is unchanged from baseline.
9. Measured: the canonical log drops ~30% of bytes and ~91% of records versus
   today. (Originally written as "≥80% smaller"; that conflated event share with
   byte share and was corrected by measurement — see the table above.)
10. Forking a session with a live sidecar produces a fork containing settled
    turns only, and does not error.
11. A session whose final events are `background_shell_completed` / subagent
    lifecycle events **after** a settled `assistant_turn` still drops its
    sidecar at close. This is the regression test for the defect that the
    structural drop rule would have introduced.

## Validation

Commands (all require `NODE_ENV=test`, per `AGENTS.md`):

```
NODE_ENV=test pnpm test source/services/logging
NODE_ENV=test pnpm test source/services/conversation
NODE_ENV=test pnpm test          # full suite
pnpm typecheck
```

The writer is not a provider, bridge, run-loop, registry, or non-interactive
component, so `pnpm test:provider-black-box` is **not** required by the
non-negotiable in `AGENTS.md`. Run it anyway before merge if the recovery path
in `conversation-replay.ts` is touched in a way that affects turn
reconstruction.

### Baseline — captured 2026-08-13 on `delta-sidecar-log` at `131117a8` (no code changes)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean, exit 0 |
| `NODE_ENV=test pnpm test source/services/logging source/services/conversation` | **534 passed / 534**, 27 files |
| `NODE_ENV=test pnpm test` (full) | **6108 passed, 1 failed, 2 skipped** (480 files) |

The single pre-existing failure is unrelated to logging:

```
source/components/InputBox.test.tsx > InputBox recognizes Alt+Enter when
terminal input arrives in split chunks
AssertionError: expected busyMode "follow_up", received "steer"
```

Treat that one failure as the accepted baseline. **Any other failure in the full
suite, and any failure at all in the two scoped suites, is caused by this
change.** The scoped suites are the primary signal — they are fully green today,
so they have zero tolerance.

Note: the ink-layer `act is not a function` failures described in `AGENTS.md`
did **not** reproduce here, because these commands pin `NODE_ENV=test` as
required. Do not reintroduce them by dropping the prefix.

## Implementation sequence

Each step should be independently mergeable and independently tested.

1. ~~**Baseline.** Capture validation output. No code changes.~~ **Done** — see
   the baseline table under "Validation".
2. **Route deltas to the sidecar.** Second fd in `ConversationLogWriterImpl`,
   shared `#seq`, sidecar never fsync'd. Widen `readLogTailState` to span both
   files (hazard 4 — required here, not in step 3). Handle `rotate()` and
   `close()` ordering per hazards 2, 2a, and 6. Tests: routing, rotation,
   clean-close deletion, mid-turn retention, trailing-shutdown-event deletion
   (criterion 11), seq recovery from a sidecar-dominant tail.
3. **Merge on read.** Recovery reads sidecar when present and merges by `seq`.
   Tests: replay equivalence for clean, crashed-mid-turn, and crashed-post-settle
   sessions.
4. **Startup GC** for orphaned sidecars, keyed on lock liveness.
5. **Fork decision** — implement whichever branch of hazard (7) review settles on.
6. **Measure** and record the real size reduction against criterion (9).

## Review outcome (2026-08-13)

Reviewed adversarially against the code. Confirmed unchanged: deltas have a
single reader, `seq` contiguity is not assumed anywhere, the `.jsonl` naming
hazard is real, and deltas are excluded from `FSYNC_EVENTS`.

Changes made in response:

| Finding | Disposition |
| --- | --- |
| Structural drop rule never fires (shutdown appends after last turn) | **Accepted.** Replaced with the `#hasUnsettledTurn` flag, hazard 2. Regression test added as criterion 11. |
| `readLogTailState` must span both files, and in step 2 | **Accepted.** Moved into step 2; shipping step 2 alone would corrupt seq. |
| Check/unlink race | **Rejected as stated.** `append()` already no-ops once `#closed` is set (line 330). Recorded as hazard 2a with the required close ordering. |
| GC race between `releaseLock` and `unlink` | **Accepted, simpler fix.** Unlink before releasing the lock; no marker file. |
| Fork semantics undecided | **Accepted.** Decided: sidecar is not copied. Criterion 10. |
| SSH concurrency / subagent log isolation | **Not applicable.** One writer (`cli.tsx:743`), one journal (`session-composition.ts:429`); subagents emit no deltas. Recorded as hazard 8. |

Still open, deferred by default:

- Should the sidecar be truncated at each turn settle rather than at session
  close? It bounds disk during long sessions and is O(1). Now cheaper than when
  first deferred, since hazard 2 already gives the writer turn-settlement
  awareness. Revisit after step 3 if long-session disk use proves to matter.
- Does anything outside `source/` (log viewer at `tools/log_viewer/`, eval
  scripts) read conversation logs and assume deltas are inline? Review did not
  confirm this either way. **Check before step 3.**

## Resume here

**Steps 1–6 are implemented on `delta-sidecar-log`.** The plan is complete apart
from the one open policy question below.

Shipped in step 2/3:

- `conversation-log-events.ts` — `DELTA_SIDECAR_SUFFIX`, `deltaSidecarPathFor`,
  `SIDECAR_EVENT_TYPES`.
- `conversation-log-writer.ts` — lazy `#deltaFd`, `#hasUnsettledTurn`, delta
  routing in `append()`, two-file seq recovery in `#initialize`, sidecar
  handling in `rotate()`/`close()` with unlink-before-unlock.
- `conversation-persistence.ts` — `readEnvelopes` merges the sidecar by `seq`;
  `decodeEnvelopeLines` split out.

**Steps 2 and 3 were merged into one change and are NOT independently
mergeable**, contrary to the original sequence. Shipping step 2 alone would
route deltas to a sidecar that no reader consults, silently regressing
interrupted-turn recovery. Do not split them when rebasing.

Design change made during implementation: `#appendDelta` sets
`#hasUnsettledTurn = true` itself. A test showed that deriving the flag only
from `user_message` lets a delta written outside that window have its sidecar
dropped at close. A delta is direct evidence a turn is streaming, so it is the
better signal.

Shipped in steps 4–6:

- `conversation-persistence.ts` — `collectOrphanedDeltaSidecars()`, called once
  at startup from `source/cli.tsx` before the writer opens.
- Fork behavior asserted (criterion 10): the sidecar is not copied.
- Size reduction measured; criterion 9 corrected from ≥80% to ~30% of bytes.

**The GC rule in this plan was wrong and was corrected during implementation.**
See hazard 6: keying collection on lock liveness would have deleted exactly the
crash-recovery sidecars the feature exists to preserve. It now keys on the
canonical log's absence.

Next action: **decide the retention-window policy question in hazard 6** (expire
crashed-session sidecars after N days, or keep them indefinitely). Nothing else
is outstanding. Then merge to `main` with `git merge --no-ff delta-sidecar-log`.

Findings already established — do not re-derive:

- Deltas are 91.5% of the corpus by event count (measured, 557 sessions).
- Deltas are read **only** by `applyInterruptedTurnJournals`, and only for turns
  where `sawFinalTurn` is false.
- `seq` contiguity is not assumed anywhere; gaps are safe.
- A `.jsonl`-suffixed sidecar would corrupt the resume picker via
  `listConversations`' glob. Use `<sessionId>.deltas`.
- Mirroring the full stream to two files was considered and rejected: it doubles
  fsync on the critical path. Splitting by event type keeps writes at exactly one
  per event.
- A structural "last event was `assistant_turn`" drop rule was considered and
  **disproven**: shutdown appends shell/subagent events after the final turn
  (`cli.tsx:844-845`, `session-composition.ts:759-761`), so it would almost never
  fire. Use the `#hasUnsettledTurn` flag.
- There is exactly one log writer and one journal per process. Subagents and SSH
  introduce no concurrency here.
- **Deltas are 91.5% of events but only 29.8% of bytes** (185 MB of 620 MB,
  measured exactly). Do not restate this as a ~90% disk saving; the disk win is
  ~30% and the record-count win is ~91%.
