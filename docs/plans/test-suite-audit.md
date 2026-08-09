# Test suite audit

Status: in progress. The solo foundation is being built; explorer calibration and cleanup require later approval.

## Resume here

Work in `/home/qduc/term2/.worktrees/test-suite-audit-foundation` on branch
`test-suite-audit-foundation`.

The current milestone is non-destructive. Finish the typed graph, read-only helper,
centralized baseline, and verification. Do not dispatch explorers and do not remove,
rewrite, retier, or consolidate tests during this milestone.

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
      `git diff --check`. All green on 2026-08-09: 9 focused tests, 458 suite
      files passed with 1 skipped opt-in Docker test, `tsc --noEmit` clean,
      Prettier clean. `scripts/**` is a global ESLint ignore in
      `eslint.config.js`, so `scripts/test-audit/` is type-checked and
      formatted but not linted, as with the rest of `scripts/`.

Completion criterion: another session can validate and query the empty graph,
reproduce the baseline command, and prepare calibration assignments without
re-deriving the vocabulary or safety rules.

### 2. Calibration wave

Waiting for explicit approval. Two explorers independently inspect the same 10–20
representative test files. The coordinator reconciles disagreements and changes the
rubric or schema before wider fan-out.

Completion criterion: disputed terms have one canonical interpretation and the
calibration report records agreement and remaining ambiguity.

### 3. Domain exploration

Waiting for calibration. Run non-overlapping domain assignments in waves. Selective
second review is mandatory for deletion candidates, high-risk seams, low-confidence
records, expensive retained tests, and a sample of ordinary keeps.

Completion criterion: every in-scope test file has a validated graph record and all
mandatory second reviews are reconciled.

### 4. Cleanup batches

Waiting for audit approval. Implement approved changes in bounded worktrees, with
area-specific regression gates and before/after measurements.

Completion criterion: each batch is independently reviewable, bisectable, and
reversible, and no approved Behavior Contract loses evidence accidentally.

## Baseline method

Run Vitest once, without concurrent explorers or other test processes, using its
JSON reporter. Store the raw output outside the repository and record only the
reproducible command, aggregate result, slowest files, and environmental caveats in
`docs/test-audit/baseline.md`. Repeat measurements later before making runtime claims;
one run is cartography, not a stable performance benchmark.

## Solo-foundation verification

- `pnpm test scripts/test-audit/graph.test.ts`: 8 passed.
- `pnpm test`: 5,810 passed and 1 opt-in test skipped across 459 files.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 34 existing warnings and no errors.
- Changed-file Prettier check: passed.
- `pnpm test-audit validate`: passed for the empty source graph.
- `git diff --check`: passed.

## Open schema questions raised by review

These surfaced in the 2026-08-09 foundation review and must be settled before the
calibration wave produces artifacts, while the graph is still empty and cheap to
reshape.

- **A second opinion has nowhere to live.** The validator permits exactly one
  decision per Test, and no record carries a reviewer or provenance. Milestone 2
  runs two explorers over the same files and Milestone 3 makes selective second
  review mandatory. Either give a decision a reviewer and supersession shape, or
  state that reconciliation happens outside the graph and only the agreed decision
  is recorded.
- **Artifacts have no defined path into the graph.** IDs are unique only within one
  artifact, and there is no merge command or collision convention. Wave-based
  fan-out ends with several validated artifacts and no sanctioned way to combine
  them.
- **A deletion candidate need not name its replacement.** The explorer brief calls
  for *named* retained coverage, but the schema is satisfied when any unrelated test
  happens to share the contract. Requiring at least one `replacementTestIds` entry
  for `deletion_candidate` would make the brief and the validator agree.
- Smaller gaps: nothing prevents two `file` records for the same path or a `case`
  record with no parent file record; `report` counts decisions but never undecided
  tests, which is the progress number a fan-out needs; the baseline records CPU
  seconds but not thread count, which dominates its wall-clock figure.

## Deferred decisions

- Exact calibration sample.
- Domain shard boundaries after inventory.
- Whether runtime history belongs in checked-in artifacts or CI.
- Whether mutation testing is proportional for disputed high-value contracts.
- Whether the default/CI suite topology should change.
