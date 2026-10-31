# Evidence-driven development experiment

**Testing policy remains active.** On 2026-10-31 the user retired routine task,
defect and test-result bookkeeping: “remove the noise, keep what is useful for
learning about past mistakes or help debugging only.” This is not a decision
that the experiment succeeded, ended, or that its test gates should be removed.

The original review milestone was the later of 2026-11-05 or 30 completed tasks.
It is historical context, not a requirement to reconstruct task counts after
bookkeeping retirement. The user still owns the testing-policy decision.

## Hypothesis

Removing permanent unit tests reduces the total cost of delivering correct software without a meaningful
drop in quality. Success means equally trustworthy software for less total effort. It does not mean
agents followed the new rules.

This is an exploratory trial. Thirty tasks cannot establish confidence about rare regressions, so the
result is a decision about the next step, not proof that unit tests are unnecessary.

## Rules

1. Do not commit permanent unit tests. CI and the pre-commit hook enforce this with
   `scripts/check-no-unit-tests.mjs`.
   Explicit user-authorized exception: the [generated verification pilot](../generated-verification/README.md)
   may retain bounded generated properties/tooling. This does not authorize a restored
   example-based unit suite or change the remaining required tiers.
2. Integration, e2e, provider black-box tests and the seven static repository guards stay and keep running
   in CI.
3. Every change gets verification proportional to its risk.
4. Agents choose their own verification methods (the `verification` skill gives the standard, not the
   method).
5. Temporary tests and scripts are allowed. Keep them untracked and delete them when done.
6. Verification must produce observable evidence. "I read the code and it looks right" is not evidence
   for a behavioral change.
7. Report unverified claims and remaining uncertainty explicitly. Never claim success that was not
   checked.
8. High-risk changes need independent verification by a separate agent that did not implement them.
9. Do not weaken verification to improve apparent results.

Writing a unit-style test inside an `*.integration.*` or `*.e2e.*` file to get around rule 1 is a review
finding. An integration test must cross a real module boundary: process, filesystem, network fixture,
persisted session, or the built CLI.

## What changed in the repository

- Tag `unit-suite-baseline` points to the last commit with the full unit suite (700 files). Restore
  any file with `git checkout unit-suite-baseline -- <path>`.
- The default Vitest tier (`pnpm test`) now runs only the static guards listed in
  `scripts/check-no-unit-tests.mjs`, plus any uncommitted temporary tests. These guards scan source
  text and enforce architecture rules (theme colours, core boundaries, stream ownership, retired
  APIs), so they work like lint rules. Adding a guard needs the user's approval.
- Removed: `pnpm test:related`, `pnpm test:changed`, and the deterministic lane (`pnpm test:lane`,
  `vitest.lane.config.ts`, `.github/vitest.lane.safe.txt`). Each one selected unit tests.
- Test helpers and `*.mock.ts` files stayed, because some integration and e2e tests use them. Some
  are now unused.
- Many plan and contract docs still name unit test files as evidence. Those references point to the tag.

## Learning without routine accounting

Report verification and its limits in the task handoff. Keep durable notes only
when they help explain a past mistake, recurring failure, guard behavior, failed
approach or recovery. Use the relevant existing area doc, skill or code comment;
there is no replacement ledger, per-task schema or required successful-run entry.
Runtime logs, conversation state and tool-execution records are unrelated and
remain unchanged.

The [interim assessment](interim-results-2026-10-24.md) retains the useful findings
and measurement limits. The October 24 human decision was “Continue with
measurement and verification improvements.” The October 31 direction retires
the accounting part, not the verification improvements. In particular, independent
failure-path acceptance and honest source/environment attribution still matter.
[Targeted acceptance evidence](acceptance-verification-2026-10-24.md) and
[profile-display findings](bare-profile-display-2026-10-24.md) retain their concrete
reproductions and limitations.

Exhaustive former task, defect, test-run and frozen measurement records remain in
git history before this cleanup (source snapshot `42724797`). They are historical
evidence, not append targets. Do not treat a missing record as zero effort, zero
defects or proof of acceptance.

## Reconsidering the testing policy

The original rollback concerns still apply: two or more escaped regressions of
the same kind that verification keeps missing; clear quality deterioration where
comparable evidence exists; or rising human intervention because agents cannot
verify independently. A lack of comparable measurements does not prove safety
or deterioration. Do not weaken verification to make the experiment look better.

Any final assessment should state what was learned, what escaped and why, the
limits of any cost/quality comparison, and a recommendation: keep, keep with
changes, partial restore, or full restore. The user decides. A rollback can
restore the suite from `unit-suite-baseline` in whole or in part.
