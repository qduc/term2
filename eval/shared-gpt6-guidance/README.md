# Shared instruction changes — 2026-09-23

The production prompts now state skill precedence explicitly, require a brief
answer before continuing with tools after a status or side question, and ask
workers to report checks before and after their edit separately. These are
shared instructions; no model-specific branches or effort defaults changed.
Both previous steering notices still strip correctly from saved conversations.

## Method and scope

The unchanged runner at `eval/luna-diagnosis/runner.mts` was used with
`LUNA_VARIANT=baseline` throughout. Despite the historical environment-variable
names, it takes any supported model on the command line. Baseline runs read
production prompts at `5dcab96d`; candidate and holdout runs read the production
prompt changes in this commit, without experimental instruction injection.
All requests used Codex HTTP, low effort, `store: false`, and no application
retries. The eight original cases were scheduled three times per run, with a
300-second process timeout. Holdout runs scheduled the three previously failing
cases three times, with a 180-second timeout.

The holdout changes the filename, typo, check command, status question, and
skill requirement, as documented in `../luna-diagnosis/README.md`. It is a
related wording check, not an independent benchmark. Connection errors stopped
their process; fresh invocations have a `-repeat` suffix. Every completed
response and every error is retained, including the initial interrupted runs.

Manual acceptance checks tool choice and requested edit/check content, a status
answer together with continuation, cancellation, avoiding redundant checks,
and accurate distinction between pre-edit and post-edit validation. The raw
`passed` field checks only tool choice and basic completion, so it misses a
silent status response. Diff review may be listed as after-edit evidence when
the response correctly says no post-edit lint/test ran. A report that says no
check was required is not a failure merely for omitting an unnecessary baseline
check; falsely claiming no checks ran is a failure.

Tools are advertised but never executed. These probes do not establish
executable patch correctness, recovery after real tool errors, streaming order
of text versus calls, or performance in long real tasks. The samples are small
and uneven because of transport failures. Passing results are observations,
not general model reliability estimates.

## Results

Manual acceptances / completed responses, combining original invocations and
their retained repeats:

| Model | Baseline, original cases | Candidate, original cases | Candidate, holdout |
| ----- | ------------------------ | ------------------------- | ------------------ |
| Astra | 20/20                    | 14/14                     | 8/8                |
| Sol   | 24/24                    | 24/24                     | 6/6                |
| Luna  | 3/5                      | 24/24                     | 7/10               |

There were 135 completed responses and 11 connection errors; no timeout expired.
Missing responses are excluded from denominators. In particular, Astra's
original candidate set and both Astra/Sol holdout sets are incomplete.
`results.json` records each invocation's counts, manual failures, summed request
time, and terminal result. The `.log` files retain raw output including startup
lines, so they are not pure JSONL.

Luna's baseline failures were redundant permission and a missing status answer.
Its holdout failures were two redundant permission requests and one patch sent
to `shell`. All six candidate Luna status responses and all six worker summaries
passed across original and holdout wording. Baseline transport failures prevented
a fresh Luna worker-summary observation; the earlier investigation supplies that
comparison. This is not a balanced statistical experiment.

## Interpretation

The original cases support adopting the narrow shared wording. Completed Astra
and Sol responses show no regression in the evaluated behaviors. The new
worker reports distinguish baseline checks from validation of the edited file,
and Luna now answers the status question while continuing with the requested
check. Luna still sometimes asks for redundant permission on the reworded skill
conflict, and once sent a patch to the wrong tool. The stronger precedence
sentence is not a complete fix for those behaviors, and no model-specific
workaround was added.

## Repository validation

- Red: 8 expected failures and 14 passes before the production change.
- Focused green: 22 tests passed in 2.23 seconds.
- Related: 130 files, 2,269 passes and 3 expected failures; 62.76 seconds, exit 0.
- Changed: 131 files, 2,275 passes and 3 expected failures; 59.08 seconds, exit 0.
- Typecheck, ESLint, Prettier, and diff whitespace checks passed.

Dynamic Markdown loading is covered explicitly by the worker and assembled
subagent prompt tests. The related/changed tests cover the steering consumers.
No full unit/integration suite was launched: this changes three instruction
sites and saved-prefix recognition, with no provider or run-loop changes.

## Prevention and sibling check

This was preventable at the instruction and evaluation level; free-form model
output cannot be made correct by TypeScript types. The observed gap was latent
in the wording retained by `bdc660ef`, not a proven model regression. The unit
tests pinned general phrases, and the mechanical probe score checked tool
selection without requiring a status answer or truthful validation timing.
The prompt contracts now pin explicit precedence across the existing model-family
matrix, report phases, and the status sequence; saved-prefix tests protect the
coupling between steering text and persisted history. Raw responses and manual
acceptance expose the semantic gap instead of treating process exit 0 as proof.

Sibling inspection covered `gpt-5.6.md`, the subagent base prompts,
`fragments/gpt-6.md`, `approval-model.md`, and `orchestrator.md`. Their broader
instructions do not conflict with these local rules, so they were left intact.
The shared skill fragment remains the single policy source for its consumers.
The orchestrator's captured last validation command still needs interpretation
against edit history; this change does not create a structured provenance
guarantee. No additional runtime validator or automatic retry was introduced:
the semantic behavior remains evaluated rather than mechanically enforced.

## Reproduce

Run the baseline at `5dcab96d` and the candidate at this change. Each command
consumes provider quota. Substitute `gpt-6-sol` or `gpt-6-luna` for Astra.

```sh
LUNA_VARIANT=baseline LUNA_ALL_CASES=1 LUNA_ROUNDS=3 timeout 300 pnpm exec tsx eval/luna-diagnosis/runner.mts codex gpt-6-astra
LUNA_VARIANT=baseline LUNA_PARAPHRASE=1 LUNA_ROUNDS=3 timeout 180 pnpm exec tsx eval/luna-diagnosis/runner.mts codex gpt-6-astra
```
