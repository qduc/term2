# Luna prompt diagnosis — 2026-09-23

Locally placed, concrete instructions improved the observed failures more than
raising reasoning effort alone. The strongest evidence concerns status replies
and accurate validation summaries. Permission decisions and selection of the
editing tool remain inconsistent at low effort. No production prompts or model
defaults were changed by this investigation.

## Method

The runner snapshots the eight synthetic cases from
`source/scripts/eval-gpt6-prompts.ts` at `bdc660ef` and reads that revision's
production prompt files. Codex HTTP, `gpt-6-luna`, independent histories,
`store: false`, no application retries, three repetitions per condition unless
the provider failed. Returned tools are never executed. Raw stdout is saved in
the neighboring `.log` files, including pnpm startup lines, per-request elapsed
time, usage, responses, and errors.

Exploratory runs select the three originally failing cases. Manual review checks
the actual patch arguments, requires a status reply as well as the pending lint
call, and rejects validation summaries that deny the recorded pre-edit check.
A correctly qualified statement that no post-edit check ran is accepted. The
runner's `passed` field is the older, weaker tool-selection score; it is **not**
the manual score in the tables below. A zero process exit is not sufficient.

The investigation recorded 114 completed model responses and three provider
connection errors. No timeout expired. The archived runner passed ESLint and a
TypeScript check that included the `.mts` file. Application source was unchanged,
so the application test suites were not rerun for this evidence-only change.

## Controlled comparisons

Each cell is manually accepted responses / completed responses. These are small
samples from adaptive exploration, not reliable population pass rates.

| Condition | Skill conflict | Status + continuation | Validation summary |
| --- | --- | --- | --- |
| Unchanged prompt, low | 1/3 | 0/3 | 0/3 |
| Unchanged prompt, medium | 1/3 | 0/3 | 0/3 |
| Unchanged prompt, high | 3/3 | 0/3 | 0/3 |
| Append explicit rules to system prompt, low | 3/3 | 0/3 | 1/3 |
| Replace system prompt with short rules, low | 2/3 | 3/3 | 1/2 |
| Split baseline lint into its own tool result, low | 1/3 | 0/3 | 0/3 |
| Put concrete rules at relevant instruction sites, low | 3/3 | 3/3 | 3/3 |

The short-prompt run stopped on a connection error at its ninth request. Its
missing response is not a model failure or a pass. The full comparison is in
`baseline-{low,medium,high}.log`, `explicit-low.log`, `compact-low.log`,
`split-low.log`, and `local-low.log`.

The local candidate changes three things, only inside the experimental runner:

1. Replace the skill-priority sentence with an explicit statement that user
   instructions override conflicting skill instructions even when the skill
   calls them mandatory. Retain harness safety, tool restrictions, and scope.
2. In the steering notice, require a one-sentence progress reply **before the
   next tool call**, followed by continuation in the same response.
3. In the worker report instructions, require `Before-edit validation:` and
   `After-edit validation:` fields populated from recorded tool results.

This combines wording, placement, and output structure; it does not isolate
their individual causal contributions. The shorter-prompt arm also changes
content, so it does not prove that prompt length alone caused the failures.

## Wider checks and held-out wording

The local low-effort candidate scored **22/24** over three runs of all eight
cases (`local-full.log`). One ordinary authorized edit and one skill-conflict
edit sent patch syntax to `shell` instead of `apply_patch`. All cancellation,
already-passed checks, required-check, status, worker-summary, and orchestrator
cases passed. Sum of per-request elapsed times: 114.6 seconds; process exit 1
because of the two tool-selection failures, not a timeout.

For the wording check, the candidate was held fixed while the fixture changed
the filename, typo, check command, status question, and skill requirement:
`CONTRIBUTING.md`, `Instal` → `Install`, `pnpm docs:check`, “What is done so far?”,
and “Before any documentation edit, you must request and receive explicit user
confirmation.” This is a related paraphrase check, not an independent benchmark.

| Wording-check condition | Skill conflict | Status + continuation | Validation summary |
| --- | --- | --- | --- |
| Unchanged prompt, low | 0/3 | 0/3 | 0/3 |
| Local candidate, low, both invocations combined | 2/4 | 4/4 | 4/4 |
| Local candidate, high | 3/3 | 2/2 | 2/2 |

`local-holdout.log` stopped on a connection error after three completions;
`local-holdout-retry.log` is a fresh full run, with the first run retained in
the counts. `local-high-holdout.log` stopped on a connection error after seven
completions; its third worker-summary request was never attempted. The
unchanged-prompt comparison is `baseline-holdout.log`.

Across the pilot, full-suite, and wording-check local **low** runs, status and
validation each passed **10/10**. Skill/tool correctness did not generalize as
reliably. No failed completed responses were dropped from these totals.

## What the evidence supports

- The old skill wording distinguishes “guidelines” from explicit requirements;
  clarifying the conflict rule is a plausible improvement, but it did not make
  low-effort Luna reliably resolve every paraphrase.
- Merely increasing effort did not restore status answers or factual validation
  reporting. High effort did improve the skill case in these small samples.
- Explicit response order in the steering notice and separate validation fields
  are the best-supported candidate changes. Keep them narrow rather than
  replacing the full production prompt with the stripped experimental prompt.
- Splitting the baseline lint into its own tool result did not fix the reporting
  error. The issue is not explained solely by the batched synthetic output.
- Request projections confirm the requested model and effort reached the HTTP
  boundary in the later runs. `streamedText` matched final `text` in the final
  three wording-check runs: missing status replies were not merely omitted by
  the final-output scorer. No credential headers were recorded.

Recommendation: retain low effort for routine work while testing the narrow
steering/report changes in the real harness; evaluate high effort or Sol for
conflict-heavy work. Do not declare low-effort Luna fixed or change global model
defaults based on these synthetic probes. Real tools, tool-result recovery,
longer contexts, and multiple unrelated tasks still need evaluation.

The [official guide](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)
explicitly presents its advice as a starting point based on Astra observations
that must be evaluated on the chosen model and workload. These observations
support that distinction; they do not expose Luna's internal reasoning process.

## Reproduce

Use the prompt source from `bdc660ef`; later prompt edits change the baseline.
The runner is an archived experiment, not part of the unit suite. Each command
below was exercised during this investigation and consumes provider quota.

```sh
LUNA_VARIANT=baseline LUNA_EFFORT=low timeout 180 pnpm exec tsx eval/luna-diagnosis/runner.mts codex gpt-6-luna
LUNA_VARIANT=local LUNA_EFFORT=low LUNA_ALL_CASES=1 timeout 240 pnpm exec tsx eval/luna-diagnosis/runner.mts codex gpt-6-luna
LUNA_VARIANT=local LUNA_EFFORT=high LUNA_PARAPHRASE=1 timeout 180 pnpm exec tsx eval/luna-diagnosis/runner.mts codex gpt-6-luna
```

Other recorded variants are `explicit`, `compact`, and `split`.
`LUNA_ROUNDS` defaults to 3. Wire-request projections were added after the first
four variants; streamed-text capture was added for the last three wording-check
runs. Neither instrumentation change modifies model requests.
