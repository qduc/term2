# Context lifecycle and retry incident handoff

## Resume here

Integration complete on main: retry recovery repair merged in `6d9648b1`; live-
background rollover merged in `9485b1ef`. No new agents or tasks were dispatched
after the prior batch. Both implementation worktrees and branches were removed.

## Context lifecycle outcome

Evidence/decision remains merged in `eaadf2a5`: reproducible corpus analyzer and
report under `docs/research/context-lifecycle-economics/` and
`docs/research/context-lifecycle-economics.md`. Parent reran artifacts exactly
and 7 analyzer tests passed in the predecessor session. Decision remains
optional phase-boundary rollover, no new default threshold or automatic schedule.

Rollover retains runtime/client/execution owners and uses mutable SessionIdentity
for the fresh root. Tool handles and background notifications survive; root
transcript, provider chain, compaction and authorization caches reset. Pending
interactions and queued-work guards remain. Final parent acceptance additionally
fixed reset-then-rollover identity sharing (`68462c5e`) and resolved concrete
session IDs in merged retry diagnostics (`2c2681df`). Writer admission precedes
external mutation; partial external writer failure is not promised rollback.
See `docs/plans/session-rollover-handoff.md`.

## Retry incident outcome

Canonical findings: `docs/bugs/invalid-chain-worker-recovery.md`. Parent found
the missing time dimension: a prior recovery starts a 90-second deadline that
never ended during successful work in the same logical turn. The regression
now drives an actual earlier WebSocket failure, successful tool-producing model
response, then Invalid previous_response_id after 900,000ms fake time. With
only the completion reset disabled, the delayed case throws that exact error;
the immediate case passes. With the fix both issue a full-history replacement.

`700df65c` bounds consecutive recovery episodes instead of the entire logical
turn. Only accepted terminal model completion ends an episode; partial tokens,
failed streams and tool activity do not. Limits stay 90,000ms / 3 physical
recovery attempts / 1 automatic replay, and total-run containment is unchanged.
Diagnostic snapshots remain observational; actual budget claim results enforce
admission (parent corrected the worker patch which ignored those results).

This explains and repairs the local failure to recover under the retained
same-turn incident timeline. Historical admission counters were not recorded,
so additional simultaneous refusal reasons cannot be excluded. The external
provider reason for rejecting its recently returned ID remains unknown; do not
claim a provider-side fix. Exact request evidence remains in the canonical bug
report and predecessor handoff history.

## Verification

- Final integrated isolated worktree full suite: 8,067 passed, 5 failed,
  3 expected failures, 2 skipped. Not green. The five failures are the nested-
  approval scripted acceptance plus four file-tool workspace/symlink cases;
  parent independently reproduced all five on main before integration.
- Final integrated provider black-box: 177 passed, 1 skipped.
- Typecheck passed in the integrated worktree and main.
- Rollover acceptance: 154 passed / 6 files after reset-identity repair.
- Final main focused App/hook/service/retry verification: 85 passed / 5 files.
- Related/changed gates ran: retry worktree 3,649 passed / 5 known failures;
  final integration edits 991 passed / 1 known nested-approval failure.

## Preserved user work

All original dirty files remain unstaged: `.coord/orch/HANDOFF.md`,
`source/components/input/SettingsMenuSession.test.tsx`,
`source/hooks/conversation-ui-reducer.ask-user-bugfix.test.ts`,
`source/hooks/conversation-ui-reducer.ts`, `source/hooks/use-conversation.ts`.
Original three untracked docs remain. To avoid stashing/committing overlapping
user edits, `e6a54afc` staged only the five additive rollover hook lines through
an index-only patch, then the merge preserved the remaining dirty diff. The
temporary patch was removed. No active background jobs or subagents.
