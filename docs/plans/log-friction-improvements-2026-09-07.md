# Log and live-session harness friction improvements

## Resume here

User authorized parallel diagnosis and implementation of the problems exposed by the last 24 hours of logs and this investigation itself. Coordinator owns this record, prioritization, review, integration, and final validation. No lane is accepted solely on a worker report.

Baseline main: `dbf3657d`. Existing untracked `docs/plans/run-code-nested-approval-preflight.md` belongs to other work and must not be modified.

## Evidence window

App logs: 2026-09-06 07:43:49 through 2026-09-07 07:43:49 local UTC+7. Included Sept 6 base and rotations .1-.15, plus Sept 7 base. Queries selected literal structured level warn/error or ok:false fields, parsed each matching JSON record, then filtered timestamps; embedded transcript mentions were not counted. Counts are records, not unique incidents, and do not establish production defects versus development probes.

- 66 run_code finish records with ok:false. Causes and pre/post-fix attribution need investigation.
- 15 shell timeout warnings. Recent timeout program already merged; distinguish older running builds and expected test deadlines.
- 22 Codex request-failure records: 6 invalid previous_response_id, 4 missing tool output, 3 cancelled, 3 early WebSocket close, 3 connect timeout, 3 ECONNRESET.
- 16 Agent stream failed records: 11 cancelled, 2 invalid previous_response_id, 3 early WebSocket close. These overlap lower-layer failures.
- 11 Conversation stream error records: 10 abort messages, 1 invalid previous_response_id.
- 25 project-hooks-disabled warnings. Configuration status, not automatically a defect.
- 1 native-compaction connection-error warning, continuing unchanged.

Live-session observations: glob default search returned no app logs until no_ignore:true; explorer asked three times for parent parsing and could not use parent tools; explorer role prompt mentions run_code while its tool set may omit it; parent aggregation exceeded 200 nested calls and returned no partial aggregate; an overlarge aggregate projection was spooled and had to be re-queried; repetitive background status replies conveyed little progress.

## Ownership and dependency graph

| ID | Scope | Owner / isolated branch | Dependency | Acceptance |
| --- | --- | --- | --- | --- |
| L1 | AgentClient cancellation telemetry, preserving actual failures and cleanup | cancellation-telemetry / log-cancellation-outcomes | independent | red/green regression, focused checks, diff review |
| L2 | Explorer safe search fallback and truthful tool guidance; no relaxed shell policy | explorer-search-friction / explorer-search-friction | independent | actual role assembly tests and prompt capability coverage |
| L3 | Ignored-file no-match discovery guidance | glob-discovery-friction / glob-discovery-friction | independent of L2 code | preserve ignore defaults and structured result contract |
| L4 | run_code call-budget/aggregation diagnostic recovery | run-code-budget-friction / run-code-budget-friction | no overlapping run_code writer | preserve guard and effect safety, deterministic regression |
| L5 | Provider continuity invalid IDs / missing outputs | provider-continuity-friction / provider-continuity-friction | separate provider files from L1 | trace live versus probes, reproduce before changing runtime |
| L6 | Shell timeout post-fix attribution | log-timeout-attribution / log-timeout-attribution | read-only assessment first | evidence-backed disposition, no speculative default increase |
| L7 | Remaining run_code failures, hooks noise, notification/delegation friction | coordinator triage | serialize overlapping changes after L2/L4 | classify evidence and assign bounded follow-ups |
| L8 | Compact responsive background task strip; full controls retained in Ctrl+G | compact-task-activity / compact-task-activity | independent UI files | 6+ task and short-terminal render regression; before/after row counts |
| V | Independent review, integration, final required gates | coordinator | all accepted implementation lanes | inspect diffs/tests, run required gates, commit/merge/cleanup |

## Guardrails

No automatic increase of caps/timeouts/retries; no automatic replay of tool effects; no expansion of explorer shell authority. Existing closed plans remain relevant, especially run-code authoring friction, nested approval, sandboxed code host, chain settlement, and evidence-backed shell timeouts. Separate confirmed defects, provider/network events, development fixtures, already-fixed behavior, and unresolved evidence.

## Latest accepted checkpoint (2026-09-07 08:56)

Additional merged fixes: validation receipts0a441e0e (parse real first-line exit status; unknown instead of fabricated0; independent64tests), focused test selector f9198e79 (strip leading pnpm separator, preserve NODE_ENV/test/noarg suite; independent7tests), shell signalled-process timeout attribution144f54a0 (safe SIGTERM repro; external signal is process-terminated not deadline; independent109tests). Typecheck passed. Latest fullsuite8304passed/20failed/3expected fail/2skipped,625files,141.448s shell/139.28sVitest. Exact failure comparison unchanged20baseline, no new failures. Output /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788746039337-b688b5.txt.

Evidence reports merged: docs/reports/provider-continuity-friction-2026-09-07.md (94151cd1 provenance correction); docs/reports/timeout-hooks-attribution-2026-09-07.md (included144f54a0); docs/reports/run-code-error-attribution-2026-09-07.md (8071ffba). IMPORTANT review correction: coding/diagnosis activity is live harness usage, not deliberate probes. Provider10errors no probes established; d27 ordinary conversation verified using session_read and report corrected. 66script failures:37prefix classes with shipped diagnostic mitigations NOT resolved outcomes;29unclassified/projection gaps (25missing bodies in bounded projection,1high197call count NOT proofbudget exhaustion,3unknown prefixes). Canonical bodies not yet inspected for25. Do not report these closed.

Active implementation/investigation lanes: provider-compaction-debt true-crane-334, branch same (trace representative live missing-output after compaction with no replay); cancellation-siblings oblique-beet-934, branch conversation-cancellation-telemetry (remaining conversation/provider abort logging, coordinate provider overlap). Completed lane worktrees cleaned; these2remain. No shell gate active. Current process was not restarted/reloaded; merged rollover fix does not prove running coordinator uses it. Avoid rollover while live workers until safe.

Open work beyond these lanes: script result-body attribution29unknowns, oversized/spooled output, repetitive background status, shell probe quoting friction, remaining provider stale-anchor causal outcomes, possibly hooks diagnostic noise (25startup config events not hook execution failure). User authorized ALL observed issues; do not stop at merged batch or blame agents. Latest feature/test changes need providerblackbox final gate if new lifecycle changes land; fullsuite rerun only after new changes warrant.

## Earlier accepted checkpoint (2026-09-07 08:33)

Merged L1/L2/L3/L4/L8 and rollover-survival fixes into main. Implementation heads: cancellation 36625ca7; explorer c0656929; budget 5259d42f; UI cc310932; glob c83ccb0c; rollover ee03f328. Main follow-up 50196f02 updates BottomArea integration expectation to compact task contract (baseline red34pass/1fail, green35pass).

Rollover root cause: successor AgentClient configuration refresh -> SubagentBridge.clearSubagentCache -> SubagentManager.resetMentorSession also reset async registry. Fix removes unrelated registry reset; explicit cancellation/disposal retained. Integrated regression crosses public ConversationService rollover, successor first request, real AgentClient/bridge/manager, child completion/result and exactly-one pending notification. Fake provider/child boundary; no live coordinator rollover proof. Parent independently ran115tests across5files.

Combined gates: typecheck passed; provider blackbox177passed/1skipped (59.03sVitest); fullsuite after BottomArea correction8290passed/20failed/3expected fail/2skipped,624files (617passed/6failed/1skipped),159.483s shell /157.44sVitest. Exact failure-identity comparison: no new failures versus original22. CLI help and InputBox failures did not recur. Fullsuite output /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788744743427-e17dfe.txt. Suite is NOT green.

Evidence-only active lanes: continuity sheen-copper-94 (provider-continuity-friction), timeout/hooks stout-globe-146 (log-timeout-attribution),66script errors trim-tortoise-225 (run-code-error-attribution). Continuity blocked log access was answered: use captured projections/specialized reads, no stopping live logger; mark unknowns.

Remaining12-issue inventory beyond accepted checkpoint: oversized/spooled script output, repetitive status notifications, accidental test -- selector broad runs, cancelled summaries falsely displaying exit0, unsafe shell probe quoting/stray files, sibling cancellation telemetry. These are not all fixed. Four original log buckets remain under classification.

## Earlier successor update (superseded by latest checkpoint)

Baseline full suite finished FAILED: 22 failed, 8278 passed, 3 expected fail, 2 skipped; 8 failed files, 615 passed, 1 skipped. Shell elapsed 264.667s; Vitest 259.03s. Output: /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788742893045-3772a6.txt. Includes known nested-TMPDIR signatures, approval model mismatches, CLI and UI failures; attribution remains open.

All six ongoing workers were cancelled immediately after rollover. Root shell survived. User confirmed this violates survival contract. Lifecycle investigation: honest-bluebell-70, branch rollover-subagent-survival; no live rollover probes.

Recovered commits: explorer c0656929; budget 5259d42f; UI 5ea9e174 plus regression cc310932. Parent reviewed first diffs and independently ran explorer 58, budget 92, UI 35 tests green. UI follow-up reports rich task regression red at 24 rows before fix, green at 8 rows afterward for 72/120 columns; 37 tests green, pending parent inspection. No height-clipping claim. No implementation merged yet. Cancelled glob/provider/timeout lanes remain open.

## Earlier results (superseded where noted above)

Program record committed on main as `32e5710b`. No production lane merged yet.

L1 returned commit `36625ca7`: cancellation logs debug `stream.aborted`, actual provider failures remain error `provider.response.failed`; cleanup unchanged. Parent inspected diff and independently ran `pnpm --dir .worktrees/log-cancellation-outcomes test ./source/lib/agent-client.application-run-loop.test.ts`: 36 passed (Vitest 13.32s, shell elapsed 24.031s). Worker reports baseline 34 passed, red proof then 36 passed, typecheck passed, provider black-box 177 passed/1 skipped. Related gate failed; worker attribution to pre-existing failures was initially unverified.

Unchanged-main full-suite baseline started with `pnpm test`, deadline 900000ms, job `6667436a-f1c5-4765-ad09-c08c71055b3a`. STILL RUNNING at last record; rely on terminal notification, do not poll. Failure-progress monitor `watch-1` was cancelled to reduce noise; job itself remains running. Early failures reproduced on unchanged main in search-replace, apply-patch, non-interactive, app.nested-approval-hide, scripted-adapter acceptance. Await final output and diagnose environment/baseline before integration. Root switching with enter_worktree was refused while this job runs; independent focused validation used pnpm --dir instead.

L8 screenshot evidence: `/tmp/herdr-clipboard-images-1000/client-148-clipboard-1788742535264981664-0.png`; six expanded cards consume ~37 rows, conversation disappears. User explicitly requested fixing UI during parallel coordination. UI worker owns BackgroundTasksPanel and associated tests, must preserve full manager inspection.

Pending coordinator follow-up: assess all 66 run_code failure causes (L4 asked to collect if practical), handle remaining conversation/provider cancellation logging beyond AgentClient after sibling review, and review repeated escalation/background status friction without weakening controls. Never call all findings closed just because first scoped patches land.

Native background handles: L1 `sage-forsythia-961`; L2 `muted-briar-720`; L3 `sleek-crocus-349`; L4 `native-birch-330`; L5 `thistle-laurel-293`; L6 `quintic-yew-572`. L1 has returned; six isolated workers remain active including L8 `lesser-weasel-284`. The initial explorer `brave-bell-190` completed without aggregates; parent obtained structured category counts directly. Its three blocker questions are part of L2 evidence, not a completed investigation.
