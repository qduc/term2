# Queued input across session rollover: author evidence

## Current R1 repair versus frozen first-candidate evidence

The original `FIX_REPORT.md`, original manifests and earlier logs describe the
first candidate, which independent review rejected for missing successor journal
records. They remain historical and unchanged. The current retained runner now
also stages `journal-repair.fixture.tsx.txt`: five real journal-writer/rotation/
replay/raw-count controls in addition to the original eleven (sixteen total).
`journal-cancel.fixture.tsx.txt` preserves the reviewer's unmodified three-case
probe. New red/rework/green identities and logs are under `evidence/journal-repair/`;
`JOURNAL_REPAIR_REPORT.md` and `JOURNAL_REPAIR_MANIFEST.json` identify the repaired
candidate, not the original root manifest. Independent recheck is still required.

R1 transfers already-journaled pending user records at the existing successor
briefing acceptance boundary: briefing record first, transferred accepted records
next, then any newer during-briefing records. The same outstanding entry holds
the full UserMessage snapshot (including edits/skill metadata), and only queued
entries are marked at rollover reset. Unsettled steers retain their admission-
callback journal owner. Queue starts remain projection-only, so ordinary queued
submissions do not produce duplicate journal records. No new queue, replay loop,
provider path or writer transaction is introduced.

This directory retains reproduction data for the isolated dirty patch on
`3b611e52aa8f1d5ffb195b0b01abd89d53851419`, not a clean-commit certification or
independent acceptance. Parent review/triage and integration remain required.
No permanent example test was added to a test tier.

## Contract and cause

Accepted messages must not veto interactive rollover. Messages queued before
rotation, while the callback prepares it, and while the successor briefing runs
must remain owned, dispatch after the handoff in the successor, and preserve the
queue's existing order without duplicate starts. Ordinary edit/retract,
follow-up, admitted steer, released-steer priority and cancellation/resume must
remain unchanged. Genuine interactions/approvals and active foreground execution
must still block unsafe identity mutation. Failed/cancelled handoffs must retain
input and the raw brief for manual recovery, without inventing automatic retry.

The original service veto conflated queued input with pending interaction.
Separately, `ConversationAdapter.#runQueuedTurn` awaited the queue's completed
event, which could dispatch another request **before** resolving the submission
that lets `ConversationOrchestrator` call the hook's turn-end callback. Merely
deleting the veto therefore sends queued input to the predecessor. Rollover's
presentation reset also cleared pending-row/ownership projections, and the queue
sidecar captured the original session ID.

The change uses the existing queue completion barrier and dispatch hold, not a
new queue. Interactive hooks opt into a service-owned reservation; ready
consumption is saved for the existing turn-end callback. Runtime preflight and
App writer-before-runtime-commit ordering are unchanged. The rollover-only UI
reset preserves pending rows, deferred activators and submission generation.
The typed `submit_held` bootstrap command requires an idle held queue, inserts
the briefing before retained steers/follow-ups, and releases dispatch. Subsequent
ordinary messages use unchanged queue scheduling. Queue sidecar storage accepts
the same mutable identity and moves the old sidecar before its next replacement.

### Settlement choices

- Writer/preflight failure, no handler, or cancellation before switching: keep
  pending input in the predecessor and pause it for explicit resume/discard.
- Briefing failure after switching: keep pending input in the successor's
  existing failure pause. Propagate this internal bootstrap failure to the
  handoff owner; ordinary sends still render errors under their old contract.
- A real pending interaction blocks consumption or preparation, rather than
  granting new authority. A request blocked at consumption retains its existing
  queue behavior and manual-retry notice; it does not silently drop input or
  automatically retry rollover. The blocked probe observes its queued user turn
  delivered once to the predecessor, as on base.
- Existing stop-during-briefing behavior is queue cancellation, not a forced
  rollover retry. Ordinary failure/cancellation proof and tool-occurrence
  settlement were not replaced.

Guard contract: lifecycle admission/ordering; enforcement is the queue completion
barrier and held-bootstrap admission; recovery owners are the existing queue
pause/resume/discard paths and hook manual-retry notice. The direct signal is a
ready request at a settled boundary, not queue length or elapsed time. There is
no numeric limit, configuration, clamping, new timeout, persisted-setting
migration, provider retry or approval grant. Rollback must keep veto removal and
reservation/bootstrap ordering together. See the guard-ledger entry.

## Reproduce

With this worktree's local dependencies:

```sh
node docs/experiments/rollover-queue/verify.mjs
```

The runner creates two temporary source test files with exclusive creation,
prints source-patch and fixture hashes, invokes actual Vitest/React Ink hooks,
and removes only its own files in `finally`. Fixture copies are data (`*.txt`),
not permanent tests. A pre-existing file at either staging path is an error,
not permission to overwrite it.

`hook-runtime.fixture.tsx.txt` mounts the real `useConversation` hook with the
real orchestrator, `ConversationService`, runtime/turn adapter, `ApplicationRunLoop`
and `SessionContextService`. Only the outer agent-client request source and
model are offline fixtures. The client supplies a synthetic ready rollover
request; this does **not** exercise the `session_rollover` tool implementation.
The callback commits the real `prepareRolloverWithNewId` transition and calls the
real presentation reset and briefing sender. Model requests contain actual
runtime-built history and traffic-context session identity, not a replacement
renderer's simulated result. Deferred boundaries permit controlled arrivals.
The fixture does not mount the full App or exercise a real conversation writer.

`persistence.fixture.ts.txt` uses real filesystem sidecars, mutable session
identity and the queue controller, restores a new controller from the successor
record and requires explicit resume before ordered delivery. It separately
checks storage behavior; it does not claim a crash-atomic writer/sidecar commit.

### Evidence

- `evidence/base-fixture-runner.log` and `base-status.json`: exact base production
  source, runner exit 1; seven failed and four unchanged ordinary/blocked
  controls passed. Earlier setup failures and initial red runs remain retained
  and are not presented as causal proof.
- `evidence/green-runner.log`: exact author source, exit 0; eleven checks passed.
  `SOURCE_SNAPSHOT` gives the source diff and fixture SHA-256 values. The
  `ROLLOVER_OBSERVATIONS` records contain outgoing model requests, history,
  predecessor/successor identity and final empty pending state.
- `evidence/source.patch` and `source-manifest.json`: exact nine-file source patch
  and byte hashes. The last change after the broad suite batch was an API comment
  explaining completion-boundary holds; the final replay includes that comment.
- `evidence/suite-status.json`: command argv, numeric exits and durations for
  typecheck, full lint, static guards, prohibited-unit-test check, initial
  generated invocation, provider black-box and full integration.
- `evidence/generated-queue-fixed.log`: the repeated `--property` argument selects
  only the last property: **1,000 restore-pause** cases, exit 0.
  `generated-queue-serial.log`: a separate **1,000 serial-actions** cases, exit 0.
  The first command included an extra `--` and exited 2 before testing; retained
  in `generated-queue.log`, not counted as passing coverage.
- Typecheck passed; static guards: 28 passed; provider black-box: 222 passed,
  1 skipped. Full integration: 223 passed, 4 failed, 1 skipped; exact failures
  and same-environment base comparison are recorded in `docs/test-results.json`.
  Full lint failed formatting only on immutable coordinator assignment/report
  JSON, not source errors. Base reproduction and focused changed-file checks are
  separate from that failed global result. The first base-lint attempt is invalid:
  its concurrent temporary fixture was removed during ESLint enumeration
  (`ENOENT`, exit 2). The isolated rerun retains that evidence; owned evidence
  JSON formatting warnings are corrected separately, never by changing the
  coordinator protocol files.

## Retro: queued input treated as a rollover blocker

Preventable: yes. Pending input is not an active interaction and must survive an
idle identity transition. Queue veto attribution: `8efb5aaa848db34a50e4feb4ff75600915bf742a`
(`feat: preserve live work across in-place session rollover`, 2026-09-06).
This is latent relative to the requested contract, not evidence that queued
rollover used to work. No introducing experiment task is inferred.

1. **Representability:** queue ownership and idle session identity were independent
   states. The explicit held-bootstrap command now rejects a bootstrap outside
   the held idle state; it does not rely on callers guessing timing.
2. **Single source:** queue counts duplicated the meaning of pending interaction.
   Actual interaction owners retain that authority; scheduling stays with the
   queue's completion barrier.
3. **Boundary contract:** previously the adapter resolved only after queue advance,
   but the UI assumed its completion callback owned the boundary. Reservation and
   ID-scoped settlement now state that contract explicitly.
4. **Implicit coupling:** UI resets silently discarded the queue's projections.
   Rollover reset now explicitly preserves their ownership and reducer rows.
5. **Wrong assumption:** waiting messages made rollover unsafe, while a late
   callback was presumed safe to switch before another message started.
6. **Detection gap:** no retained joint queue/rollover/next-request journey covered
   before/during rotation plus failure. Temporary tests retain reproducible data;
   no prohibited permanent unit test or disguised integration tier was added.
7. **Automation gap:** static guards/typecheck cannot see the dispatch timeline.
   Existing generated queue checks do not cover the UI/session crossover. The
   new state-checked queue operation is structural protection; the retained
   author runner detects crossover regressions but is not a new CI guarantee.
8. **Siblings:** both service queue veto sites removed; runtime active-turn and
   approval gates retained; approval-continuation completion uses the same queue
   barrier; ordinary compaction hold remains idle-only; ordinary send, admitted
   steer, released-steer priority, edit/retract and stop/resume were exercised;
   persistence ownership now follows identity. No sibling queue implementation
   or run-loop/tool-occurrence recovery logic was changed.
9. **Knowledge gap:** the old queue block was documented intentionally. The new
   invariant is now in the queue API, rollover plan and guard ledger, rather than
   an assumption that future callers know the UI callback order.
10. **Observability:** old blocked telemetry could label queued input as interaction.
    Existing queue snapshots and outgoing-request identity exposed the difference;
    existing manual-retry messages preserve the brief. No detection-latency claim
    is possible from the available history.
11. **Origin:** the live-work-preservation feature introduced the queue veto;
    admission ordering did not establish the new queue-through contract. The fix
    does not claim past test failures or an escaped-regression rate.

Fixed: queue reservation, successor-first bootstrap, retained presentation and
sidecar identity, with old-red/new-green behavioral evidence. Hardened: the
existing completion-barrier owner and a state-checked bootstrap admission, not
an extra scheduler. Design friction: this transition spans scheduling, identity
and presentation; each owner is retained, with an explicit bounded reservation
rather than resetting/copying the queue. No unrelated manager refactor was added.

## Limits and handoff

Independent high-risk verification is intentionally pending with the parent;
no child agents, provider spending, commit, merge, push, runtime installation or
other-worktree edit was performed. Full-App writer integration and real providers
were not exercised. The sidecar move occurs on the next queue save after identity
commit: no claim of atomicity across process crash/power loss and conversation
writer/sidecar files is made. Existing sidecar-write errors remain recoverable
queue diagnostics, not a new transaction mechanism. A fresh successor-sidecar
collision is refused rather than overwriting another queue. Recovery still
requires user choice where the original contract did; there is no automatic
handoff retry feature.
