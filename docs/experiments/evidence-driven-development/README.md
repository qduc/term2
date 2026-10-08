# Evidence-driven development experiment

**Status:** running since 2026-10-08. Ends at the later of 2026-11-05 or 30 completed tasks, then gets a
decision (see [Ending the experiment](#ending-the-experiment)).

## Hypothesis

Removing permanent unit tests reduces the total cost of delivering correct software without a meaningful
drop in quality. Success means equally trustworthy software for less total effort. It does not mean
agents followed the new rules.

This is an exploratory trial. Thirty tasks cannot establish confidence about rare regressions, so the
result is a decision about the next step, not proof that unit tests are unnecessary.

## Rules

1. Do not commit permanent unit tests. CI and the pre-commit hook enforce this with
   `scripts/check-no-unit-tests.mjs`.
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
9. Record every completed task in [tasks.jsonl](tasks.jsonl) and every defect found after completion in
   [defects.jsonl](defects.jsonl).
10. Do not weaken verification to improve the metrics.

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

## Metrics

Recorded per task in `tasks.jsonl` and per defect in `defects.jsonl`. One JSON object per line.

| Metric | Source | Desired |
|---|---|---|
| Task completion time | `started_at` → `verified_at`, including rework | lower |
| Verification cost | `verification.minutes`, `verification.tokens` if known, verifier cost included | lower |
| Escaped defects | `defects.jsonl` rows linked to a task, per task and per 1000 changed lines | no meaningful increase |
| Regression rate | escaped defects with `kind: "regression"` | no meaningful increase |
| Human interventions | `human_interventions` count and notes | lower |

The most important are completion time (primary), escaped defects (the quality guardrail) and human
interventions (autonomy). Normalize defects by task count and change size; a productive week must not
look worse just because more shipped.

A defect counts whenever it is found, including after the experiment ends, as long as it traces to a task
completed during it.

### Task record

```json
{"id":"2026-10-09-rollover-dedupe","type":"bugfix","risk":"high","started_at":"2026-10-09T09:12Z","verified_at":"2026-10-09T11:40Z","commit":"abc1234","files_changed":6,"lines_changed":210,"agent":"term2/<model>","claims":["rollover keeps the goal","no duplicated tool calls"],"methods":["run-app","trace-inspection","temporary-test"],"verification":{"minutes":35,"tokens":null,"independent":true,"verifier":"claude","verdict":"accept","rework_rounds":1},"uncertain":["token savings measured on one session only"],"human_interventions":0,"notes":""}
```

`type` is one of `bugfix | feature | refactor | infra | docs`. `risk` is one of `low | medium | high`
(defined in the `verification` skill). Use these `methods` values where they fit, and invent new ones
when they don't (discovering methods is part of the experiment): `typecheck`, `lint`, `static-reading`,
`temporary-test`, `temporary-script`, `integration-test`, `e2e-test`, `provider-black-box`, `run-app`,
`non-interactive-run`, `trace-inspection`, `log-inspection`, `browser-automation`, `fault-injection`,
`before-after-comparison`, `independent-review`.

### Defect record

```json
{"id":"2026-10-15-goal-lost","found_at":"2026-10-15T08:00Z","found_by":"user","task":"2026-10-09-rollover-dedupe","kind":"regression","severity":"medium","summary":"goal text dropped after second rollover","missed_because":"verification only exercised one rollover","method_that_would_catch":"run-app with two rollovers"}
```

`found_by` is one of `user | agent | ci | verifier`. `kind` is `regression` (something that used to work
broke) or `defect` (new behavior was wrong). Set `task` to `null` when the cause is unknown.

## Baseline

Compare against the four weeks before the experiment (2026-09-10 to 2026-10-08). Main had 279 merge
commits and 170 non-merge commits starting with `fix` in that window. These are rough proxies for tasks
and defects, not a matched baseline. Before the mid-point review, build a better one: sample about 30
merged tasks by type, take their duration from session logs (see the `debugging-logs` skill), and count the
fix commits that trace back to each task.

## Rollback triggers

Reconsider the policy early, rather than defending it, if any of these hold:

- Two or more escaped regressions of the same kind that the new process kept missing.
- Escaped defects per task clearly above the baseline after at least 15 tasks.
- Human interventions rising, because agents can no longer verify on their own.

A rollback restores the suite from the tag in whole or in part. A partial restore, for example only the
tests for the area that kept regressing, is also a result worth recording.

## Ending the experiment

At the end, write `results.md` beside this file covering:

- the metrics against the baseline;
- the verification methods agents used and how often each one found a defect;
- what escaped and why;
- a recommendation: keep, keep with changes, partial restore, or full restore.

The user makes the decision.
