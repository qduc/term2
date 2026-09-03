# M4 cleanup — before/after report (B1–B10 + Topology + follow-up)

Date: 2026-09-04 · Scope: Milestone 4 cleanup batches B1–B10, the Topology batch,
and the follow-up rewrite (`a2b56bd6`) (cli.e2e retier, runtime-history location,
mutation-testing recommendation). Source of truth for counts:
`docs/test-audit/baseline.md` (runtime history table), plan
`docs/plans/test-suite-audit.md`, graph `docs/test-audit/graph.yaml`.

## Test counts

Default suite (`pnpm test`, JSON reporter, no competing test processes):

| Main commit | Batch | Tests | Delta |
| --- | --- | ---: | ---: |
| `06dafa96` | B1 hooks-real-code | 7,557 | −1 |
| `876eb4b3` | B2 commands | 7,557 | 0 |
| `3e8bfe13` | B3 util-fixes | 7,557 | 0 |
| `9388adb0` | B4 conversation-utils | 7,543 | −14 |
| `fe6aba76` | B5 runtime-lib | 7,543 | 0 |
| `85f9943b` | B6 session-obs | 7,540 | −3 |
| `8bf8d2ed` | B7 consolidations | 7,532 | −8 |
| `edf840cd` | B8 shell-tools-misc | 7,537 | +5 |
| `5510ba8f` | B9 subagents | 7,535 | −2 |
| `02031587` | B10 eval+stream+provider | 7,538 | +3 |
| topology | cli.e2e retier | **7,521** | −17 (relocated) |

**Before M4 (pre-B1 `main`): 7,558 → after Topology: 7,521. Net −37 default-suite
tests**, of which 17 were relocated to the e2e tier rather than removed, and
+8 were additions (B8 table-ified matrices, B10 new seam/facade cases). The 6
environment-class failures (`needsApproval` outside-workspace / symlink-escape in
apply-patch/create-file/search-replace) and 2 skipped tests are constant across
every post-B6 run; the e2e tier (17 tests across `cli.e2e.test.ts`,
`scripts/build-output.e2e.test.ts`, `scripts/fake-codex-server.e2e.test.ts`)
now runs only under `pnpm test:e2e` (`vitest.e2e.config.ts`) and is covered by
the new CI e2e job.

## Runtime

Full-suite wall clock at B9/B10 measured ~166-168 s on the shared dev host;
the d36c392a baseline measured 49.9 s isolated (see the Interpretation boundary
in `docs/test-audit/baseline.md` — different host states and worker contention,
not a clean comparison). M4 did not target wall-clock as its primary outcome,
and the per-batch runtime deltas were not measured in a controlled way. The
topology change is the one structural runtime/CI change: a 600 s-budget PTY
smoke test (tsx cold start under CI contention) no longer runs inside the
default-suite CI job; it moved to a dedicated e2e job.

## What was removed vs strengthened

Removed or consolidated (every deletion named a replacement; the graph
validator requires `replacementTestIds` for `deletion_candidate`):

- **B1** use-resume-selection / use-skill-selection / use-shell-mode: stopped
  testing local reimplementations; extracted and tested the real pure filter
  from each hook module; collapsed a duplicate shell-mode flush case.
- **B4** conversation-event-handler.subagent and message-utils: fixed
  title/assert mismatches and dropped duplicated utility cases.
- **B6** session-observation: folded non-empty assertions into the guard test
  they duplicated.
- **B7** consolidations: deleted `app.startup-banner` (covered by app-helpers),
  folded the misnamed `use-conversation.approval-pending-filter` file into
  `approval-presentation-policy.test.ts` and deleted it, deleted ~5
  scope-resolver traversal cases duplicated in
  `scope-resolver.security.test.ts`, and replaced the
  `command-safety.red-yellow-policy` paths case with
  `shell-command-safety-path` per the calibration verdict (plus
  command-safety.git dedupe/table).
- **B9** subagents: dropped the probabilistic 500/2000-draw loops for one
  deterministic sample; stripped dead split-suite imports; replaced three
  agent-runtime shape cases plus a fake parent-attenuation case with one real
  delegated-handle execution.
- **B10** persistence-recovery-matrix: removed a dead no-work-rerun counter.
- **Topology** cli.e2e/build-output.e2e/fake-codex-server.e2e: removed from the
  default suite discovery, retained in the e2e tier.

Strengthened (assertions made to mean what their titles claimed, or coverage
added at real seams):

- **B1/B3** extracted real production helpers (hook filters, settings
  value-suggestion helpers) and tested them directly instead of local copies.
- **B7** command-safety path cases now assert the calibrated RED/YELLOW
  semantics.
- **B8** tool-parameter-schema optional-vs-nullable matrix, SettingsSelectionMenu,
  HandoffConfirmationPrompt, InputContext, ssh-service — tautology cases
  removed or made to assert their titles (+5 net tests).
- **B10** leaderboard penalty is now observable (each model gets a correct
  low-severity case plus a wrong high-severity case; wrong-approve clamps to 0
  vs wrong-reject 0.25); report.test asserts the overall/category/failure/
  critical-false-approval sections; stream-event-processor cases retitled to
  what their fixtures assert and the approval case seeds its shared argument
  map; gateway.test split into five seam files
  (workspace-admission / compacted-cursor / worker-boundary /
  logging-lifecycle) with facade coverage; provider-management-session gained
  list/save/delete facade-delegation tests against a mocked provider-service.

## Contract evidence

**No contract lost all covering evidence.** Three test records were deleted
(B7): their contracts remain covered by the named replacements, and each flip
to `keep`/`high` carries evidence citing the surviving file. Graph totals
throughout M4 and the follow-up: 602 tests / 694 contracts / 1224 decisions (unchanged since B7;
Topology added no records because the three e2e files were already recorded with
`suiteId: e2e` / `provider-blackbox-e2e`). Residual integrity note (deferred,
unchanged): test files created after the `d36c392a` inventory — including B10's
four gateway seam files — are not graph records.

## Gates per batch

Every batch ran its touched files' tests, the no-isolate lane, and a fresh
full-suite JSON run before landing. B1–B10 suites were green except the constant
6 environment-class failures; the lane was green except the same env-class set.
Provider-adjacent batches (B10, and the B10 PBB re-run on main `02031587`) ran
`pnpm test:provider-black-box`: **176 passed / 1 skipped, exit 0**. The Topology
batch changed no provider/bridge/run-loop/registry code and its vitest base-config
exclude does not affect `vitest.provider-black-box.config.ts`, so PBB was not
re-run for it; the e2e-tier files it touches run under `pnpm test:e2e`
(3 files / 17 tests, exit 0) and `pnpm test:codex-network` (15 tests, exit 0).

## Open items and owner reports

- **Architecture signal (report to owners, no test change):**
  `docker-host-control.integration.test.ts` — end-to-end Docker host-control
  scenarios gated behind `RUN_DOCKER_HOST_CONTROL_INTEGRATION=1` and skipped in
  every default/lane run. Owners: `source/tools/system` / docker sandbox
  maintainers. Recommendation stands: keep as an opt-in integration suite; do
  not admit to the default suite, and do not delete — it is the only
  end-to-end Docker grant/lease coverage and runs in environments that opt in.
- **Follow-up rewrite (completed):** `shell-command-safety` and
  `hooks-use-settings-completion-test` landed in `a2b56bd6`. The former is now
  table-driven for approval-required and safe commands; the latter replaces the
  line-169 tautology, under-constrained maxResults assertions, and weak
  composition checks with exact assertions. Both graph primaries are now
  `keep/high`.
- **Mutation testing:** recommendation written for user approval —
  `docs/test-audit/mutation-testing-proportionality.md`. Not a standing gate;
  justified on demand for `shell-command-classification` (after `a2b56bd6`) and
  `observability-chain-fingerprint`.
