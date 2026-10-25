# Queue rollover fix — author handoff

**Status: implementation complete; independent high-risk verification pending with parent.**
No commit, merge, push, child agents, paid/live providers, installed-runtime
change, original-checkout edit, or other-worktree edit was performed.

## Outcome and cause

Queued messages no longer veto rollover. The interactive queue reserves the
settled boundary before dispatch, the successor briefing runs first, and retained
messages (including arrivals during rotation/briefing) then use ordinary queue
ordering. A released steer retains its existing priority behind the bootstrap.
Pending UI rows and executable submission ownership survive the presentation
reset. The persisted queue sidecar follows successor identity on its next save.

Two causes required fixing together:
1. `ConversationService` treated queued input as a pending interaction in both
   consumption and admission.
2. Adapter completion advanced the queue before the orchestrator/hook turn-end
   callback could switch identity. Deleting the veto alone sends input to the
   predecessor.

The patch reuses `QueueController`'s completion barrier and dispatch hold. Its
state-checked `submit_held` bootstrap admission is not a new queue subsystem.
Actual approval/check-in owners and runtime active-turn preflight remain gates.
Ordinary send/edit/retract/steer/cancel behavior is unchanged by policy.

Writer/preflight failure or cancellation before rotation retains queued input
for explicit resume/discard in the predecessor. Briefing failure after rotation
keeps the queue's existing failure pause in the successor. The raw handoff remains
visible for manual retry; there is no automatic rollover retry. A request blocked
at consumption keeps its existing queue delivery behavior and manual-retry notice
(the control delivers its queued input once to the predecessor).

## Exact patch and changed paths

Base: `3b611e52aa8f1d5ffb195b0b01abd89d53851419` on `coord/rollover-queue`.
Nine production paths, **137 additions / 30 deletions**:

| Path | Responsibility |
| --- | --- |
| `source/services/queue/queue-controller.ts` | Completion-boundary reservation; held successor bootstrap before retained input |
| `source/services/conversation/conversation-adapter.ts` | Existing completion barrier callback and bootstrap submission routing |
| `source/services/conversation/conversation-service.ts` | Remove queue veto; reserve/consume/settle by rollover ID; cancellation fence |
| `source/services/conversation/conversation-orchestrator.ts` | Preserve queued ownership on rollover reset; propagate bootstrap failure |
| `source/services/conversation/conversation-orchestrator.types.ts` | Explicit rollover-only queue-preserving UI reset option |
| `source/hooks/use-conversation.ts` | Interactive reservation lifecycle and final release/manual recovery |
| `source/hooks/conversation-ui-reducer.ts` | Keep pending rows/snapshot on rollover-only reset |
| `source/services/conversation/conversation-adapter-factory.ts` | Pass shared identity to queue sidecar |
| `source/services/conversation/queue-persistence.ts` | Move sidecar ownership instead of leaving a predecessor replay copy |

Documentation/evidence changes:
- `docs/plans/sessions/session-rollover-handoff.md` and
  `docs/plans/approvals-and-sandbox/guard-ledger.md`: contract and recovery rationale.
- Append-only `docs/experiments/evidence-driven-development/tasks.jsonl`,
  `defects.jsonl`, and `docs/test-results.json` (15 task-linked verification runs).
  Historical ledger prefixes/records were checked unchanged.
- `docs/experiments/rollover-queue/`: retained fixture data, safe replay runner,
  concise root-cause/retro checklist, command exits, logs and source identities.
- `CHANGE_MANIFEST.json`: every changed source/doc/evidence path and SHA-256;
  excludes itself and this last-written report from self-hashing. The publishing
  helper hashes this report. It lists 64 paths; with manifest/report, 66 paths.

Production diff: `docs/experiments/rollover-queue/evidence/source.patch`.
SHA-256: `e8db57671b83836b7948158151e9fe029f38d2c786d7971ede19df071ad8fa03`.
Full tracked source/docs diff: `docs/experiments/rollover-queue/evidence/changes.patch`.
Final nine-file hashes: `evidence/source-manifest.json` in that directory.

## Observed verification

Reproduce behavioral evidence:

```sh
node docs/experiments/rollover-queue/verify.mjs
```

The runner exclusively stages temporary source fixtures, mounts real hooks and
orchestration, runs the actual service/session identity transition and application
run loop, captures actual outgoing model history plus traffic-context session ID,
then removes its fixtures. It does not mock a replacement renderer or assert
source regexes. The model and outer client request source are offline fixtures.
A second probe crosses real filesystem sidecars and restores a fresh queue.

| Check | Numeric exit and observed result |
| --- | --- |
| Same runner on clean base production | **1** — 7 failed / 4 passed; `base-fixture-runner.log` |
| Same runner on exact final patch | **0** — 11 passed; `green-final-exact.log` |
| `pnpm typecheck` | **0** — final exact source |
| `pnpm test` | **0** — 28 static guards passed |
| `pnpm check:no-unit-tests` | **0** — no temporary source tests remain |
| Generated `queue.serial-actions`, seed 424242 | **0** — 1,000 cases |
| Generated `queue.restore-pause`, seed 424242 | **0** — 1,000 cases, separate command |
| `pnpm test:provider-black-box` | **0** — 222 passed / 1 skipped, 25 files |
| `pnpm test:integration` | **1** — 223 passed / 4 failed / 1 skipped |
| Same four integration cases on clean base | **1** — same 4 failed / 51 unselected skipped |
| Changed-source/runner ESLint and Prettier | **0 / 0** — no errors; existing no-this-alias warning |
| Full final `pnpm lint` | **1** — 0 ESLint errors / 31 warnings; formatting only on 3 immutable coordinator JSON files |
| Final manifest/bookkeeping format, historical-prefix checks, `git diff --check` | **0** — passed |

The eleven behavioral checks cover queued-before (zero and multiple), queued-
during rotation and briefing, successor-only delivery after briefing, order/no
duplicate starts, writer failure, cancelled rotation, blocked interaction,
briefing failure, ordinary edits/retraction/follow-ups, released and actually
admitted steering, ordinary stop/resume, and persisted successor recovery.

The four integration failures reproduce on unchanged base with identical denial
signatures in `source/cli.integration.test.ts`:
- Bare profile via **flag** and **config**: result.txt absent; sandbox blocked shell.
- Outside-workspace edit boundary: approval-denied text instead of expected exit code.
- Explicit sandbox scratch write: outside.txt absent; non-interactive approval denial.

These are not declared green or fixed here. Immutable `.coord` assignment and
published progress JSON were not reformatted. Base lint reproduced their warning
signatures; two owned status-JSON formatting warnings were corrected separately.
The first base-lint attempt was invalid (`ENOENT` from concurrently removed
fixture, exit 2); a standalone base rerun is retained. Initial fixture-setup/API
mistakes and an extra-`--` generated-command parse failure are also retained,
not mislabeled as causal red or passing tests.

Provider/integration broad runs used byte-identical behavior before a final
holdDispatch API-comment clarification. `suite-source-manifest.json` reconstructs
and checks that exact earlier hash; final runner/typecheck/static/generated
checks cover exact delivered source. No behavioral code changed after the suites.

## Retro, limits, and next owner

Preventable, latent relative to the requested queue-through contract. Blame
identifies veto commit `8efb5aaa848db34a50e4feb4ff75600915bf742a` (live-work-preserving
rollover, 2026-09-06); no introducing experiment task or past queued-through
success is inferred. The weakness was an implicit ordering assumption between
queue completion and UI settlement, plus clearing a retained queue's projections.
The existing completion-barrier owner and state-checked bootstrap admission now
make the boundary explicit. Both service veto sites and approval-completion,
compaction-hold, ordinary queue and persistence siblings were checked. Full
proportional retro/checklist is in the experiment README.

**Design friction:** scheduling, identity and presentation span existing owners;
kept an explicit bounded reservation rather than copying/resetting the queue or
adding a manager. No unrelated refactor or new retry subsystem.

**Remaining verification:** parent independent review/triage is required before
acceptance/merge. The author probe does not mount the full App/writer or invoke
the actual `session_rollover` tool; it supplies a synthetic ready request and
performs the real session switch through the real hook callback. No live provider
or crash/power-loss atomicity is claimed. The sidecar moves on its next queue
save after identity commit, not in a transaction with the conversation writer;
existing persistence failure recovery remains in force. No new manual-recovery
semantics were invented for unrelated clear/remount paths.

**Processes:** all owned shell/test subprocesses settled; no child agents and no
live owned verification processes. See `evidence/process-check.json`. Local copied
`node_modules`, build output/caches and retained evidence remain in this isolated
worktree. Parent owns independent review, combined integration and any commit/merge.
