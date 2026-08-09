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
      `git diff --check`. See `## Solo-foundation verification`.

Completion criterion: another session can validate and query the empty graph,
reproduce the baseline command, and prepare calibration assignments without
re-deriving the vocabulary or safety rules.

### 2. Calibration wave

Waiting for explicit approval. Two explorers independently inspect the same 10–20
test files. The coordinator reconciles disagreements and changes the rubric or schema
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
- Whether runtime history belongs in checked-in artifacts or CI.
- Whether mutation testing is proportional for disputed high-value contracts.
- Whether the default/CI suite topology should change.
