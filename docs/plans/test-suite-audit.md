# Test suite audit

Status: Milestones 1-3 complete. Calibration wave ran 2026-09-02 and PASSED its
  go/no-go (report: `docs/test-audit/calibration-report.md`). Milestone 3 (domain
  exploration) closed 2026-09-03: all 585 test files at the `d36c392a` inventory
  have validated graph records (28 reviewer artifacts + coordinator
  adjudication), and the source graph (`docs/test-audit/graph.yaml`) holds 605
  tests / 694 contracts / 1230 decisions. Milestone 4 (cleanup batches) is in
  progress: batches B1 (hooks-real-code), B2 (commands), B3 (util-fixes), B4
  (conversation-utils), B5 (runtime-lib), B6 (session-obs), B7
  (consolidations), B8 (shell-tools-misc), and B9 (subagents) landed 2026-09-03 as
  `audit-m4-b1` (`7c90b29a`), `audit-m4-b2`
  (`13c97871`), `audit-m4-b3` (`3f09d676`), `audit-m4-b4` (`8b8e8842`), `audit-m4-b5`
  (`66ff03d0`), `audit-m4-b6` (`1522a0fb`), `audit-m4-b7` (`2b2b4201`),
  `audit-m4-b8` (`db3890cf`), and `audit-m4-b9` (`229bb354`); the graph
  now holds 602 tests / 694 contracts / 1224 decisions after B7 removed two
  whole-test-file records (app.startup-banner, the misnamed hook-named
  approval-pending-filter) and one case record (red-yellow-policy paths); deferred
  decisions
  (suite-topology change, runtime-history location, mutation-testing
  proportionality) gate parts of it.
## Resume here

Start future audit work from current `main` in a dedicated worktree. The original
`test-suite-audit-foundation` worktree has been removed; its work is present on
`main`.

Read `docs/test-audit/calibration-report.md` for the calibration verdict, the M3
artifacts under `docs/test-audit/artifacts/` for reviewer records, and
`docs/test-audit/shards.md` for domain boundaries. Milestone 3 is closed;
coordinator override decisions live in `graph.yaml` primary decisions (reviewer
`test-audit-coordinator`) for rtk-service, worktree-transition,
conversation-event-handler.tools, token-usage, build-output.e2e, cli.integration,
and use-settings-completion. Milestone 4 cleanup batches are next: each in an
isolated worktree with before/after test count + fresh full-suite runtime, and
verification proportional to the touched area. Do not remove, rewrite, retier,
or consolidate tests outside approved cleanup batches.

The graph source of truth is `docs/test-audit/graph.yaml`. Its validator and query
code lives under `scripts/test-audit/`; run `pnpm test-audit validate` after every
graph edit. The future explorer contract is `docs/test-audit/explorer-brief.md`.

## Objective

Reduce test-suite cost while preserving or strengthening evidence for important
Behavior Contracts. Runtime reduction is an outcome to measure, not a reason by
itself to remove a test.

## Model

- A `Test` provides evidence for one or more `BehaviorContract`s.
- A `BehaviorContract` protects one or more `Risk`s at one or more `SystemSeam`s.
- A `Test` belongs to one `Domain` and one `Suite`, and may use `Fixture`s.
- A `Test` record starts at file granularity and expands to case granularity only
  when cases within the file require different contracts or decisions.
- An `AuditDecision` records a recommendation, evidence, confidence, replacements,
  and review status. It does not overwrite facts about the Test.
- “Low quality” is not a graph property. It is an imprecise conclusion that must be
  replaced by explicit cost, risk, unique-signal, and replacement evidence.

The initial recommendations are `keep`, `rewrite_candidate`,
`consolidation_candidate`, `retier_candidate`, `deletion_candidate`,
`architecture_signal`, and `needs_review`.

## Guardrails

- Exploration is read-only and produces structured records rather than edits.
- Measurements are collected centrally; concurrent test runs would contaminate
  timing evidence.
- A proposed deletion must not leave any Behavior Contract without another test.
- Every deletion candidate receives independent review before implementation.
- Approval routing, terminal input ownership, queue/injection behavior, prompt
  behavior, provider fidelity, the Run Loop, and shipped regressions are
  high-scrutiny areas.
- Cleanup happens later in small isolated worktrees. Each batch reports test count
  and runtime before and after and runs verification proportional to the touched
  area.
- Provider, bridge, Run Loop, registry, and Non-interactive Mode changes additionally
  run `pnpm test:provider-black-box`.

## Milestones

### 1. Solo foundation

- [x] Establish the graph vocabulary and initial schema.
- [x] Add focused tests for typed references, duplicate IDs, orphan prevention,
      querying, and reporting.
- [x] Add read-only `validate`, `list`, `show`, and `report` commands.
- [x] Write the canonical explorer brief.
- [x] Collect a centralized baseline and record its environment and limitations.
- [x] Run focused tests, the full suite, typecheck, formatting checks, and
      `git diff --check`. See `## Solo-foundation verification`.

Completion criterion: another session can validate and query the empty graph,
reproduce the baseline command, and prepare calibration assignments without
re-deriving the vocabulary or safety rules.

### 2. Calibration wave

Complete 2026-09-02. Two independently configured reviewers inspected the same
16 files; the coordinator reconciled disagreements and wrote the decisions of
record. Report: `docs/test-audit/calibration-report.md`. The wave PASSED its
go/no-go: discrimination is demonstrated (seven verified non-keep decisions
from the adversarial stance; no invented claims; granularity canon settled at
case level where a file needs it).r schema
before wider fan-out.

A four-file probe ran first, recorded in `docs/test-audit/calibration-probe.md`.
Read it before designing the wave. Explorer judgment is usable — both reviewers
stated observable contracts and every spot-checked coverage claim was accurate — but
both returned `keep` on all four files, so their ability to reach any other
conclusion is still unmeasured. The wave sample must therefore be salted with
plausible non-`keep` files and carry a positive control, or it will reproduce that
result at four times the cost. The contract-granularity gap (22 statements versus 10
over the same four files) must be settled in the brief first, because it is not
recoverable afterwards.

Completion criterion: disputed terms have one canonical interpretation, the
calibration report records agreement and remaining ambiguity, and at least one
reviewer has demonstrably produced a non-`keep` recommendation with evidence that
survives review.

### 3. Domain exploration

In progress. Run non-overlapping domain assignments in waves over the remaining
569 files (the 16 calibration files already have canonical records). Selective
second review is mandatory for deletion candidates, high-risk seams, low-confidence
records, expensive retained tests, and a sample of ordinary keeps.

Completion criterion: every in-scope test file has a validated graph record and all
mandatory second reviews are reconciled.

### 4. Cleanup batches

Approved by the milestone-3 result (main `e3d1b8b7`). Implement approved changes in
bounded worktrees, with area-specific regression gates and before/after
measurements. The candidate pool is the graph's non-keep primaries (44 files: 37
rewrite_candidate, 5 consolidation_candidate, 1 retier_candidate, 1
architecture_signal).

Completion criterion: each batch is independently reviewable, bisectable, and
reversible, and no approved Behavior Contract loses evidence accidentally.

Batch table (each in its own worktree; after landing, flip the affected tests'
graph primary decisions to keep/high with a note naming the batch and commit):

- **B1 hooks-real-code** (high rewrites): use-resume-selection, use-skill-selection,
  use-shell-mode — stop testing local reimplementations; extract/export the real
  pure filter from the hook module and test it, collapse the duplicate shell-mode
  flush case. **Landed in `audit-m4-b1` (`7c90b29a`).**
- **B2 commands** (prompts-commands wave-1 rewrites): auto-approve-command,
  sandbox-command, skills-command, resume-command — de-duplicate harness setup;
  drop the two redundant /resume cases from hooks/use-app-commands.test.ts only if
  resume-command coverage keeps them. **Landed in `audit-m4-b2` (`13c97871`).**
- **B3 util-fixes**: settings-command (add provider unregister teardown),
  value-suggestions (test the exported isNumberSetting/isStringSetting or retitle).
  **Landed in `audit-m4-b3` (`3f09d676`).**
- **B4 conversation-utils**: conversation-event-handler.subagent (fix the
  title/assert mismatch at 571-595), message-utils (fix title/comment/assert
  contradiction ~153-163), conversation-event-handler.tools (strip stale
  "Fails:" comments at 588-663 — keep file). **Landed in `audit-m4-b4` (`8b8e8842`).**
- **B5 runtime-lib**: openai-agent-client (exercise production retry path),
  openai-agent-client.chat (replace truthiness asserts), subagent-bridge
  (cancelAsyncRuns must assert delegation; fix sink-lifetime test).
  **Landed in `audit-m4-b5` (`66ff03d0`).**
- **B6 session-obs**: conversation-session.input-surge (delete or honestly reframe
  the 304-343 TODO case), session-composition (fix dispose test ~358-367),
  conversation-logger (delete the duplicate journal-forwarding test at ~538),
  large-uncached-input-guard (fold the 354-376 non-empty assertion into 167's
  test). **Landed in `audit-m4-b6` (`1522a0fb`).**
- **B7 consolidations**: app.startup-banner (delete; app-helpers covers it),
  use-conversation.approval-pending-filter (fold retention cases into
  approval-presentation-policy.test.ts then delete the misnamed file),
  scope-resolver (delete the ~5 traversal cases duplicated in
  scope-resolver.security.test.ts; keep normalization cases),
  command-safety.red-yellow-policy paths case (replace with
  shell-command-safety-path per calibration), command-safety.git (dedupe/table).
  **Landed in `audit-m4-b7`.**
- **B8 shell-tools-misc**: tool-parameter-schema (table-ify the 7 optional-vs-
  nullable its), SettingsSelectionMenu, HandoffConfirmationPrompt,
  InputContext "multiple components" tautology case, ssh-service trailing
  tautologies. **Landed in `audit-m4-b8` (`db3890cf`).**
- **B9 subagents**: codename-run-id (drop the probabilistic 500/2000-draw loops
  for one fixed deterministic sample), the five subagent-manager split files
  (dead imports stripped; prompt/tool/retry scenarios table-ified into it.each
  matrices; three agent-runtime shape cases + the fake parent-attenuation case
  replaced by one real delegated handle execution through the manager runtime).
  **Landed in `audit-m4-b9` (`229bb354`).**
- **B10 eval+stream+provider**: eval-auto-approval leaderboard + report,
  stream-event-processor (title/fixture repairs at the cited ranges),
  provider-management-session (add list/save facade tests), gateway.test
  (split into its five seam files), persistence-recovery-matrix (drop dead
  counter, retitle).
- **Topology (needs user decision, do not execute blind)**: cli.e2e retier out of
  the default vitest include into test:e2e (requires config exclude + CI change);
  docker-host-control.integration architecture_signal (report to owners, no test
  change).

Runtime baseline: `pnpm exec vitest run --reporter=json` from the worktree with no
concurrent test processes (~50 s at d36c392a; see `docs/test-audit/baseline.md`).
Per-batch: run the touched files' tests, then the no-isolate lane
(`pnpm test:lane`), and a fresh full-suite run for the count delta.

## Baseline method

Run Vitest once, without concurrent explorers or other test processes, using its
JSON reporter. Store the raw output outside the repository and record only the
reproducible command, aggregate result, slowest files, and environmental caveats in
`docs/test-audit/baseline.md`. Repeat measurements later before making runtime claims;
one run is cartography, not a stable performance benchmark.

## Solo-foundation verification

Two sessions recorded this independently; the numbers below are the later run, at
`schemaVersion: 2`.

- `pnpm test scripts/test-audit/graph.test.ts`: 21 passed.
- `pnpm test`: 5,812 passed and 1 opt-in Docker test skipped, across 458 passed
  files and 1 skipped. Requires `pnpm build` first, because
  `source/cli.integration.test.ts` spawns `dist/cli.js`.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with existing warnings and no errors. Note that it does not
  cover the new code: `scripts/**` is a global ESLint ignore in `eslint.config.js`,
  so `scripts/test-audit/` is type-checked and Prettier-checked but never linted, as
  with the rest of `scripts/`.
- Changed-file Prettier check: passed.
- `pnpm test-audit validate`: passed for the empty source graph.
- `git diff --check`: passed.

## Schema questions settled before fan-out

The 2026-08-09 foundation review found the schema could not represent what the later
milestones produce. These were settled at `schemaVersion: 2` while the graph was
still empty, on the reasoning that reshaping a schema is cheap now and invalidates
explorer artifacts later.

- **A second opinion now has a place.** A decision carries an `id`, a `reviewer`, an
  optional `sourceArtifact`, and a `role` of `primary` or `second_opinion`. There is
  at most one decision of record per Test; independent judgments sit beside it
  instead of overwriting it. Two decisions on one Test must come from different
  reviewers, so a reviewer cannot second-review their own conclusion. Only the
  decision of record removes a test, so a dissent proposing deletion never subtracts
  evidence.
- **Artifacts have a defined path into the graph.** A test id must be prefixed with
  its `domainId`, which makes non-overlapping domain assignments safe to combine, and
  `pnpm test-audit merge` unions shared vocabulary and concatenates records. Two
  artifacts describing one contract differently is a conflict the coordinator
  reconciles; merge refuses to pick a winner.
- **A deletion must name its replacement.** `deletion_candidate` requires at least
  one `replacementTestIds` entry, so the brief and the validator now agree.
- Also closed: a path is recorded at one granularity, and mixing file and case
  records for it is rejected; `report` counts undecided tests and tests where a
  second opinion disagrees; the baseline records CPU count and pool configuration.

Reviewer independence is enforced structurally but cannot be enforced semantically.
Two explorers on the same model, given the same brief, may agree because they share
a bias rather than because the evidence is strong. Calibration should be read with
that in mind: agreement between cheap homogeneous explorers is weaker evidence than
agreement between differently configured ones.

## Domain shards

Settled 2026-08-10 in `docs/test-audit/shards.md`: 17 non-overlapping shards over all
458 test files, sized 12 to 44. Boundaries follow ownership seams rather than equal
size, because a duplication claim is only usable when both tests sit inside one
assignment. Read that file before cutting a Milestone 3 assignment.

## Deferred decisions

- Exact calibration sample. Narrowed to a stratified 16 drawn from the shard table,
  but not fixed until the calibration probe reports whether explorer judgment is
  usable at all.
- Whether runtime history belongs in checked-in artifacts or CI. *(Open; gates
  nothing before M4 batch execution.)*
- Whether mutation testing is proportional for disputed high-value contracts.
  *(Open; gates nothing before M4 batch execution.)*
- Whether the default/CI suite topology should change. *(Open; gates the M4
  topology batch only — cli.e2e out of the default vitest include into
  `test:e2e`, which needs a config exclude plus a CI run of `test:e2e`. Ask the
  user before executing.)*
