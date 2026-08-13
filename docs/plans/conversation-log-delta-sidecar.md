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

Two user-facing costs:

- **Disk.** ~91% of the conversation store is unreadable bytes. This grows
  without bound.
- **Analysis latency.** Any pass over the corpus (resume picker enumeration,
  future self-improvement tooling) walks 10x more data than it needs.
  `listConversations` (`source/services/conversation/conversation-persistence.ts:306`)
  reads each file in full to build a list entry.

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

`ConversationLogWriterImpl` is deliberately semantics-free — it appends
envelopes and knows nothing about turns. Rather than teach it turn lifecycle,
use a conservative structural test in `close()`:

> Delete the sidecar only if the last event appended to the canonical file was
> an `assistant_turn`. Otherwise leave it.

This over-retains in rare cases (a session whose final event is, say,
`settings_changed` after a settled turn). Those are collected by the startup GC
below. Over-retention is the safe failure direction: too much data, never too
little.

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

### 4. Seq recovery must span both files

`readLogTailState` resumes numbering from the highest `seq` found in the file it
opens. With deltas relocated, the true high-water mark after a crash may live in
the sidecar. Resume from `max(canonical, sidecar)` or the writer will reissue
sequence numbers and break merge ordering.

### 5. `rotate()` must move in lockstep

`rotate()` (`conversation-log-writer.ts:356`) closes the fd, releases the lock,
resets `#seq` to 0, and re-initializes under a new session id. Called from
`source/cli.tsx:818`. The sidecar must close and reopen with it, or the next
session's deltas append to the previous session's sidecar.

### 6. Orphaned sidecars need a GC

A killed process never reaches `close()`. Startup should collect sidecars whose
session is not live. The liveness signal already exists: `<sessionId>.lock`,
acquired in `#initialize` and released in `close()`/`rotate()`. A sidecar with no
held lock is either consumed by recovery or deleted.

Note the existing lock is also stale-prone after a kill (`acquireLock` throws
`LockConflictError` on `EEXIST` with no staleness check). Do not widen that
problem; GC should be read-only with respect to lock semantics.

### 7. `forkConversation` copies by id

`forkConversation` (`conversation-persistence.ts:403`) copies
`<sourceId>.jsonl` to `<newId>.jsonl`. Forking a session with a live sidecar
would silently drop its unsettled deltas. Decide explicitly: either copy the
sidecar too, or document that forking only carries settled turns. Recommend the
latter — a fork of an in-flight turn is not a coherent thing to want.

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
7. Startup GC removes sidecars with no held lock, and removes none with a held
   lock.
8. fsync call count per turn is unchanged from baseline.
9. Measured: a representative session's canonical log is ≥80% smaller than the
   equivalent log today.

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
   shared `#seq`, sidecar never fsync'd. Handle `rotate()` and `close()`.
   Drop rule (2) included. Tests: writer unit tests for routing, rotation,
   clean-close deletion, mid-turn retention.
3. **Merge on read.** Recovery reads sidecar when present and merges by `seq`.
   Fix `readLogTailState` to span both files. Tests: replay equivalence for
   clean, crashed-mid-turn, and crashed-post-settle sessions.
4. **Startup GC** for orphaned sidecars, keyed on lock liveness.
5. **Fork decision** — implement whichever branch of hazard (7) review settles on.
6. **Measure** and record the real size reduction against criterion (9).

## Open questions for review

- Is the structural drop rule in hazard (2) — "last canonical event is
  `assistant_turn`" — actually sufficient, or does some flow append events after
  a settled turn often enough that sidecars would rarely be collected at close
  and would lean on GC instead? If so, is that acceptable?
- Should the sidecar be truncated at each turn settle rather than at session
  close? It bounds disk during long-running sessions and is O(1), but adds a
  turn-lifecycle dependency to a writer that currently has none. Deferred by
  default; flag if review disagrees.
- Does anything outside `source/` (log viewer at `tools/log_viewer/`, eval
  scripts) read conversation logs and assume deltas are inline?

## Resume here

No production code changed yet. Step 1 (baseline) is complete and recorded under
"Validation". The doc is under review.

Next action: apply review findings, then start at step 2 (route deltas to the
sidecar).

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
