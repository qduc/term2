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
| V | Independent review, integration, final required gates | coordinator | all accepted implementation lanes | inspect diffs/tests, run required gates, commit/merge/cleanup |

## Guardrails

No automatic increase of caps/timeouts/retries; no automatic replay of tool effects; no expansion of explorer shell authority. Existing closed plans remain relevant, especially run-code authoring friction, nested approval, sandboxed code host, chain settlement, and evidence-backed shell timeouts. Separate confirmed defects, provider/network events, development fixtures, already-fixed behavior, and unresolved evidence.

## Results

Awaiting lane evidence. Integration commits and actual validation outcomes will be recorded here.

Native background handles: L1 `sage-forsythia-961`; L2 `muted-briar-720`; L3 `sleek-crocus-349`; L4 `native-birch-330`; L5 `thistle-laurel-293`; L6 `quintic-yew-572`. Six isolated workers are active. The initial explorer `brave-bell-190` completed without aggregates; parent obtained structured category counts directly. Its three blocker questions are part of L2 evidence, not a completed investigation.
