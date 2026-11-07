# R1 journal ownership repair — ready for scoped independent recheck

**Author repair complete; independent R1 + affected-controls acceptance pending.**
Original `FIX_REPORT.md` is unchanged. No commit, main/original checkout write,
reviewer checkout/evidence mutation, child agent, live provider or paid route.

## Routed finding and reproduced red

R1 is must-fix: a normal completed/flushed successor omitted the user inputs
accepted before writer rotation, even though their responses and actual successor
requests survived. This is journal ownership loss, not power-loss recovery.

I read the complete independent report and copied its durable three-case fixture
into this worktree without changing reviewer files. Before source edits, the
unchanged fixture reproduced **exit 1: 1 failed / 2 passed**: successor replay
contained during-briefing input but lacked queued-before-rotation and
queued-during-rotation. Intake source, fixture checksum and original report hash
are retained in `evidence/journal-repair/intake.json` under the experiment directory.

## Smallest existing-boundary correction

**Only production file changed versus the frozen candidate:**
`source/services/conversation/conversation-orchestrator.ts` — **33 additions /
9 deletions**. The other eight production files are byte-identical to intake.

- The existing outstanding-submission entry now holds its existing full
  `UserMessage` snapshot, rather than separately copied id/text fields. Its public
  id/text/stage projection is unchanged. Edits update that same snapshot, retaining
  current text and skill metadata; there is no second payload/transfer index.
- The existing rollover-only queue-preserving reset marks already-journaled
  `queued` entries for journal transfer. Unsettled steers keep their original
  admission-callback journal owner.
- Successor briefing acceptance first appends the briefing's user record, then
  transfers marked accepted records and clears their markers. New input arriving
  during the briefing is journaled afterward under the existing submission-time
  policy. This matches App's writer-before-runtime-identity ordering, exercised
  through the real `rotateSessionLog` in the probe.
- Ordinary queued starts remain presentation-only. Ordinary queues therefore do
  not append their already-journaled user records twice. Retraction removes the
  existing entry, and ordinary clear still clears it.

No queue/retry/transaction subsystem, full-transcript replay, provider/run-loop
change or new automatic recovery was introduced. Retained queue delivery remains
intact. Design friction was local: the old minimal outstanding projection lacked
its journal payload; deriving that projection from the existing full message
avoids duplicating metadata in another cache.

A first start-time transfer experiment restored the missing text but reordered
it behind input already accepted during the briefing. It remained red and was
rejected in favor of the existing acceptance boundary. Intermediate mechanical
patch-anchor/typecheck failures are retained, not represented as passing checks.
Exact transient failed-edit hashes are unavailable; the ledger correction makes
that explicit. Both intake red and delivered green identities are exact.

## Exact candidate and delta

Base: `3b611e52aa8f1d5ffb195b0b01abd89d53851419`, branch `coord/rollover-queue`.

- Current source hashes and original report hash:
  `docs/experiments/rollover-queue/evidence/journal-repair/source-manifest.json`.
- R1-only applicable patch: `evidence/journal-repair/R1-only.diff` in that directory.
  SHA-256: `5e368a0285ac7d3ab4dede89d37f0e1014298694f6cd95e58580266633093c4a`.
  `git apply --check --reverse` against the delivered source passed.
- Full current production patch: `evidence/journal-repair/source.patch`.
  SHA-256: `55d8e9f41dc63beb47fc4a210e149b81b41463f2cf28a1744399becc39436f54`.
- Current source/docs/evidence hashes and incremental paths:
  `JOURNAL_REPAIR_MANIFEST.json`. The old `CHANGE_MANIFEST.json` and original
  source patch remain historical first-candidate evidence, not current identity.
- Full current tracked diff: `evidence/journal-repair/tracked-candidate.patch`.

## Observable checks

All logs below are in `docs/experiments/rollover-queue/evidence/journal-repair/`.
`checks.json` records exact final argv, numeric exits and subprocess wall times.

| Check | Observed result |
| --- | --- |
| Unchanged reviewer fixture before repair | **Exit 1: 1 failed / 2 passed** — `red-reviewer-fixture.log` |
| Unchanged reviewer fixture on exact final source | **Exit 0: 3 passed** — `reviewer-unmodified-final.log` |
| `node docs/experiments/rollover-queue/verify.mjs` | **Exit 0: 16 passed** — `retained-runner-final.log` |
| `pnpm typecheck` | **Exit 0** — `typecheck-final.log` |
| `pnpm test` | **Exit 0: 28 static guards passed** — `guards-final.log` |
| `pnpm check:no-unit-tests` | **Exit 0** — `no-unit-final.log` |
| Focused changed-source/runner ESLint | **Exit 0** — `lint-focused.log` |
| Focused source/runner/evidence/ledger format checks | **Exit 0** |
| `git diff --check` | **Exit 0** |

The sixteen retained checks are the original eleven affected rollover controls
plus five real writer/rotation/flush/replay checks. They cover:
- queued-before-rotation, queued-during-rotation and queued-during-briefing records
  in successor replay and restored user history;
- **raw** `user_message` IDs/text exactly once, so replay deduplication cannot hide
  duplicate journal writes;
- ordinary same-session queue and released-steer records exactly once;
- cancellation during the active successor briefing, no early queued execution,
  explicit resume, then successor replay retaining both inputs;
- current edited text/skill metadata on transferred input and exclusion of a
  retracted pending input;
- all original ordering, failure/manual recovery, steer/edit/retract/cancel and
  sidecar controls.

The unchanged reviewer cases are a subset/precursor, not three additional unique
cases beyond the sixteen. Temporary source probes are removed in `finally`.
`journal-cancel.fixture.tsx.txt` preserves the unchanged reviewer fixture;
`journal-repair.fixture.tsx.txt` contains the strengthened raw-count/mutation
controls and is now staged by the retained runner. These are reproduction data,
not permanent example tests in a CI tier.

No broad unrelated suite was rerun, per scope. Earlier provider/full integration/
global-lint results remain historical; no new green broad-suite claim is made.

## Records, retro and remaining limits

Appended **13 task-linked verification/rework records** to `docs/test-results.json`,
including the independent rejection, own pre-change red, rejected experiments,
final green/affected checks and an identity-scope correction. The original
first-candidate records were verified unchanged against their exact frozen hash.
A linked `journal-repair` activity in `tasks.jsonl` records rework, not a second
completed delivery or independent acceptance. R1 was found before acceptance, so
it is not added to escaped-defect totals; `defects.jsonl` is unchanged. The
experiment README and task-owned guard ledger now describe journal transfer.

Retro: the initial live-request/sidecar runner omitted the actual conversation
writer and therefore could not prove completed-session preservation. The remedy
pairs the existing acceptance owner with full message ownership and a one-shot
transfer marker, and the durable runner now correlates live successor requests,
raw journal records and restored history. See `RETRO.md` and the appended
adaptation in `PLAN.md` under the new evidence directory.

Remaining limits: the offline probe mounts real hooks, runtime, writer and replay,
not full App or the actual rollover tool. It does exercise the same real writer-
before-identity ordering. No crash-atomicity or new recovery transaction is
claimed or required for R1. **Scoped independent reviewer recheck is still needed
before acceptance/merge.**

All owned test subprocesses settled, no child agents, and no live owned
verification processes remain. `process-and-history-check.json` records cleanup,
immutable report/history checks and all final check exits. This report was written
last; the lifecycle helper hashes it when published. No source will be committed
or main checkout modified by this worker.
