# Recorded test results

Commit-indexed observations help distinguish regressions from existing failures
without rediscovering the same baseline. This is evidence, not a failure allowlist.

## Use and maintenance

- Before diagnosing a failed run, search this file for the test path and exact
  title. Compare the error/assertion, tested revision, command and environment.
- A matching historical title alone does not establish the same cause. Confirm
  the recorded revision is relevant to the task base (`git merge-base --is-ancestor
  <recorded-commit> <task-base>`), check intervening fixes and environmental
  differences, and rerun the failing cases on the unchanged base when uncertain.
  Ancestor status alone does not prove a failure remained unfixed.
- After verification, append a record for the actual tested revision, including
  green runs that resolve previous failures. Keep historical observations intact;
  append corrections or superseding runs instead of overwriting history.
- Use the full commit hash. If tests ran before commit, explicitly label the
  working-tree snapshot and identify the resulting commit only after checking
  that the tested source, tests and configuration match. Dirty or unidentified
  snapshots are not clean-commit baselines. Record the tested source commit in a
  later documentation commit; do not invent a self-referential commit hash.
- Include command/selection, platform/runtime and relevant environment, test/file
  totals, exact failures and diagnostic signatures, and evidence. Do not infer
  unrun tiers from passing focused checks. Unknown metadata stays unknown.
- Keep logs and secrets out of this file. Retain concise failure signatures here
  so the record remains useful if a local evidence path expires. Prefer durable CI
  run/artifact links when available; identify local paths as machine-local.

New-record template:

```markdown
### <date> — <suite/selection> — <short commit>

- Tested revision: <full hash; clean commit or explicitly described snapshot>.
- Command: <exact command, including filters and environment overrides>.
- Environment: <OS, Node/package-manager versions, relevant env/config; unknowns>.
- Result: <passed / failed / skipped tests; file totals if available>.
- Failures: <path, exact title, assertion/error signature; "none" for green>.
- Comparison: <base/relevant earlier record; classification and supporting evidence>.
- Evidence: <durable artifact/link or explicitly machine-local report/log>.
```

## Observations

The following records were transcribed on 2026-10-24 from retained lane reports.
They are historical observations, not fresh test runs by the recorder.

### 2026-10-24 — full integration — b093ad0d

- Tested revision: `b093ad0d52c322d2005899f52e989e4de1d96a21`, committed
  compaction feature before merge `5b5395aa61104b6ae69b997b1c267528d5a88ea8`.
- Command: full integration tier (`pnpm test:integration`); additional invocation
  flags were not preserved in the summary.
- Environment: Linux on the developer machine. Node/pnpm versions were not
  recorded. The later repair investigation reproduced the six failures with
  inherited `TMPDIR=/tmp/qduc/term2-nodejs`.
- Result: **217 passed, 6 failed, 1 skipped**.
- Failures: the six CLI cases listed under **Approval fixture failure set** below.
- Comparison: all six were also reproduced on unchanged base
  `258a4d0a53874526a593ca47eb769e80cf2c91d2`. The baseline reproduction did not
  retain full-suite totals in the summary. The later fixture repair demonstrated
  an environment-dependent test defect; this was not a compaction regression.
- Evidence: machine-local
  `/home/qduc/term2/.term2/compact-cache-verification-20261023.md`; the subsequent
  repair commit and next record retain the diagnosis and resolving result.

#### Approval fixture failure set

All paths are `source/cli.integration.test.ts`. Exact titles:

1. `an approved shell call does not approve a later call that reuses its id when the provider repeats call_0`
2. `an approved shell call does not approve a later call that reuses its id when the provider repeats its own id`
3. `an approved shell call does not approve a later call when the chat-completions provider omits tool call ids`
4. `an approved shell call does not approve a later call when the chat-completions provider sends empty tool call ids`
5. `a call that reuses a refused call id runs and is saved as run, not as refused`
6. `bare retains the outside-workspace edit approval boundary without asking headlessly`

Cases 1–4 expected `command is RED (dangerous) and cannot be executed automatically`;
case 5 expected automatic-refusal text. All five received a YELLOW refusal with
no auto-approve model configured. Case 6 created the supposedly outside file:
`expected true to be false`.

The inherited temp root put the fixture targets inside the child's permitted
scratch directory. Changing only runner `TMPDIR=/tmp` made the six cases pass on
unchanged code. A unique fixture directory was not a separate permission root.

### 2026-10-24 — full integration — 26f0b0f5

- Tested revision: working-tree snapshot committed as
  `26f0b0f596d056bffd7726c434382ed9607b38fb`, branch
  `codex/integration-approval-failures`, based on
  `5b5395aa61104b6ae69b997b1c267528d5a88ea8`. The lane verified post-commit
  SHA256 matches for the reviewed test and agent-context documentation. The full
  suite ran before commit; it was not rerun on an integrated main checkout.
- Command: `pnpm test:integration`, run twice; the final run included fixture
  canonicalization. The original baseline reproduction command was
  `pnpm test:integration source/cli.integration.test.ts --reporter=verbose`
  (**48 passed, 6 failed**).
- Environment: Linux, worktree-local dependencies. Runner inherited the
  app-suffix temp root; the repaired harness assigns child-only `TMPDIR`, `TEMP`
  and `TMP` to a canonical per-test scratch root distinct from ordinary targets.
  Node/pnpm versions were not recorded. Native macOS/Windows were not exercised.
- Result: **224 passed, 1 skipped; 24 passed files, 1 skipped file**.
- Failures: **none**. Resolves the approval fixture failure set above. Production
  classification, approval rules and file-access permissions were unchanged.
- Comparison: independent verifier reproduced all six baseline failures, then
  passed the seven repaired denial/scratch-write cases under ordinary,
  app-suffix and symlinked temp roots. Additional scratch-symlink escape and
  sibling-prefix denial probes passed. Verifier verdict: **ACCEPT**.
- Other checks reported: typecheck, lint/format (31 unrelated warnings),
  28 static guard tests and no-unit-tests gate passed. Full e2e and provider
  black-box tiers were not run for this fixture/documentation-only repair.
- Evidence: committed fixture repair in `26f0b0f5`; machine-local reports
  `/tmp/integration-approval-lane-20261024-result.md` and
  `/tmp/integration-approval-verifier-20261024.md`.
- Integration status at recording: committed on its branch, **not merged**.
  This does not establish that current main is green; append an integrated-tree
  result when that run is performed.
