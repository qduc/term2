# Context lifecycle and retry incident handoff

## Resume here

User authorized autonomous data-backed context lifecycle improvements and live-background rollover; separately demands Invalid previous_response_id incident solved and fixed. Latest instruction: **do not dispatch new tasks/agents after the current batch; roll over**. Batch settled. Do not claim incident solved: final retry worker delivered diagnostic instrumentation, not a proven incident recovery fix.

## Integrated evidence

Main merge `eaadf2a5` contains reproducible corpus analyzer/report and decision under `docs/research/context-lifecycle-economics/` and `docs/research/context-lifecycle-economics.md`. Parent reran analyzer over Aug31-Sep05 and cmp matched both artifacts exactly; 7 Python tests passed. 22,781 requests, roughly95% cached input; 14 linked rollover same-lane pairs ~211.5k to20.3k mean input. Input-only sensitivity warm proxy amortizes in11 future requests at cached ratio.01 or2 at.1; NOT causal savings/root identity proof/threshold calibration. Decision optional phase-boundary rollover, preserve execution owners, no default threshold or automatic schedule changes.

## Unmerged rollover implementation

Worktree `.worktrees/rollover-live-work`, branch `rollover-live-work`, clean HEAD `448dee16` (fix: finish live session rollover acceptance). Baseline `2e8aff7f`. Initial flawed transfer commit `2d895dc5` was reverted `c271fe7b`; net implementation instead retains runtime/client/execution owners with mutable SessionIdentity and rollover-only root reset. Other commits `6cd58d89`, `ffba54f8`, `a47443b6`, `ef1537dd`, `fe04f696`.

Final acceptance repair addresses: preflight/commit ordering around writer mutation, successor start timestamp, retained notification dedup on presentation reset, stale model-facing instructions. Tool handles survive, root transcript/chain/compaction/authorization caches reset, pending interaction and queued-work guards remain. Current docs in branch describe limitations.

Parent independently verified final commit: pnpm test source/app.test.tsx source/services/session/session-composition.test.ts source/services/conversation/conversation-service.facade.test.ts source/services/conversation/conversation-orchestrator.subagent-notifications.test.ts source/services/session/conversation-session.characterization.test.ts source/tools/session-rollover/session-rollover-tool.test.ts =>153 passed6files; pnpm typecheck passed. Worker reports provider blackbox177pass1skip and full/related/changed baseline failures only. Earlier independent reviews rejected prior versions; final448dee16 has not yet received parent diff acceptance/integration. Inspect its new real factory/runtime and App tests, not only mocks.

## Unmerged retry investigation

Worktree `.worktrees/invalid-chain-diagnosis`, branch same, clean HEAD `48d4534b` Instrument chained recovery admission, predecessor `f44c855c` test: pin settled worker chain recovery. Report `docs/bugs/invalid-chain-worker-recovery.md` in worktree is canonical findings.

f44c adds real createSessionRuntime/ApplicationRunLoop settled-tool chain-recovery regression, baseline already passes; disabling settled exemption turns it red. It does NOT reproduce incident. 48d adds non-mutating budget snapshots and retry.recovery_admission logging in initial/continuation recovery handlers, tests. No policy loosening. Worker reports39focused tests/typecheck/provider-blackbox177pass1skip, changed3032pass+5baselinefail. Parent has not independently inspected/validated48d yet. It is a diagnostic-gap fix, not the promised incident behavior fix.

Verified incident: root session d27dc356-4eda-4882-9c38-80d8aa46cdbd, worker ember-hedge-938. Traffic directory ~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc. Successful03-14-02.025Z_8dd77.json req8dd7716d-dacd-4932-b31e-32803bf12bfe returned resp_0e15f8578ffd0bc6016a9cda7a5b3087d0a02c6d4072257df5. Failed03-14-43.242Z_b0e22.json reqb0e22a3e-ba2a-418d-b6e0-328edb3a6351 sent exact ID41seconds later; HTTP400 Invalid previous_response_id at03:14:44.137, zero frames/output. Headers x-client-request-id/session-id/thread-id end :subagent:ember-hedge-938 (root sessionId alone pools workers). Last input is completed failing test-command output, not necessarily unsettled tool. App localUTC+7 10:14:44 logs Agent stream failed, conversation.chaining_broken, then Conversation stream error for subagent-ember-hedge-938. No subsequent request by original worker; replacement swift-umbel-821 at03:15:36. Later worker found retryAttempt2 and earlier full-history recoveries; report has details. Actual admission booleans/budgets not recorded, exact cause remains unproven.

Do not repeat prior bad attribution: worker envelope and preceding response ARE retained; headers give identity. Explorer twice claimed missing because only root sessionId was examined. Do not blame stale runtime without evidence: settled-tool exemption commit a9c19cf2 datedSep02; parent process2856070 startedSep06 08:41:55; main tsc watch sinceAug29. Current source/dist contain exemption. Existing61classifier/inloop tests pass. Investigate actual long-turn budget/ledger/steering rather than asserting generic single-tool test solves mystery.

## Integration and validation hazards

Main dirty user files: .coord/orch/HANDOFF.md, source/components/input/SettingsMenuSession.test.tsx, source/hooks/conversation-ui-reducer.ask-user-bugfix.test.ts, source/hooks/conversation-ui-reducer.ts, source/hooks/use-conversation.ts. Untracked user docs run-code-authoring-friction.md, run-code-nested-approval-preflight.md, tool-real-world-log-audit-2026-09-05.md. Preserve all. Rollover DOES modify use-conversation.ts; must reconcile without stashing/reverting user changes. Retry initial/continuation recovery handler edits overlap rollover identity changes; expect semantic merge review. No merges of these branches yet.

Known full-suite failures: scripted nested approval acceptance line197 seen[] expected2 independently reproduced by parent main and rollover branch; four file-tool symlink/workspace boundary expectations worker attributes environment (parent not independently rechecked those). Do not report full suite green. Some worker tool auto summaries say exit0 while output hasFAIL; use actual test output/report.

## Next step

After rollover, inspect/validate48d diagnostic changes and final448dee16 rollover acceptance diff, integrate carefully with main dirty edits only when accepted. Retry mystery remains open and user explicitly wants solution, not just instrumentation. No new agent dispatch promised in this batch. No background jobs/subagents remain active. Existing handles need not be queried; durable reports and commits above hold state.
