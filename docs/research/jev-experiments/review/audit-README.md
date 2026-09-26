# audit.py: independent V1 audit (run `jev-fit-20260919`)

Written by the review worker (Claude Code, `claude-opus-5`, self-reported). It's stdlib-only Python and makes no network calls. It doesn't import runner or lane code, except that `baselines --baseline-script` loads a lane baseline module, and only when you ask it to. It never executes strings found in fixture data.

## Commands

All output is JSON on stdout.

| Command | What it checks |
| --- | --- |
| `audit.py --selftest` | Explicit **MOCK** fixtures: statistics, contract detection, overlap, baselines, mock exclusion, both runner record schemas, blind workflow. Not provider evidence. |
| `audit.py contract DATASET...` | Required fields (`provenance` may be nonempty text or a nonempty object, coordinator-approved in V2), unique IDs, `expected`/`baseline` ∈ criteria, ≥ 24 dev + 24 holdout per task. Duplicate canonical states (within split / across splits / across tasks). Distinct criteria sets and label sets per task. Option-count distribution. `expected` position index (`i/n`) vs the uniform expectation. Leakage heuristics (IDs only). |
| `audit.py overlap DATASET... [--threshold 0.6]` | Char 5-gram Jaccard over state leaf values. Holdout→nearest-dev distribution and flagged pairs; nearest-other-case distribution and `template_ratio` (share of cases with a near twin), which is meant to catch cyclic/templated datasets. |
| `audit.py baselines DATASET [--baseline-script P [--baseline-func F]] [--show-labels]` | Per task and split: correct counts for the stored authored baseline, the independent lexical probe, and the dev-majority baseline. With a script, it also checks reproducibility (next section). |
| `audit.py score DATASET --records JSONL... [--phase holdout] [--freeze freeze.json]` | Recomputes metrics from the runner's raw JSONL (section below). |
| `audit.py blind-view --sample S` | Prints `id/task/state/criteria` for relabeling. **Refuses** samples that carry `expected/baseline/rationale/tags/provenance`. |
| `audit.py blind-compare DATASET --sample S --reviewer R` | `R` = `{case_id: choice}`. Reports agreement per task and lists disagreements. Headline scores keep the frozen labels; disagreements are reported as adjudication sensitivity. |

## Baselines (preregistered in `interpretation-preregistered.md`)

- **Lexical probe** (independent of the lanes): reads only `state` (keys + leaves) and `criteria`. Score = share of an option's distinct tokens (label + description, length ≥ 3, minus stopwords) that appear in the state. Ties go to the earliest criteria key. That tie rule is position-dependent, which is disclosed, and the contract's position report shows its exposure.
- **Dev majority:** the majority `expected` per task, computed **from dev only**. Ties go to the lexicographically smallest label. It's applied unchanged to holdout. If that label isn't among a case's options, the case is `inapplicable` and scored wrong. The selftest proves that changing holdout labels can't move it.
- **Authored-baseline reproducibility:** the lane function (`choose` / `predict_case` / `predict`) is called on a stripped case, `{id: "audit-NNNNN", task, state, criteria}`. A crash (e.g. `KeyError: 'expected'`) counts as a violation. An AST scan lists every label-field read with its enclosing function. It's leakage only if that function is reachable from the predictor; a CLI-only read like `main()` comparing stored vs predicted baseline is listed but not flagged. A line scan flags subprocess/eval, network, and nondeterminism. The output must match the stored `baseline` field for every case.

## Scoring rules (`score`)

- **Live eligibility.** A record is excluded and listed if any of these hold: `mock` is truthy; `live` is present and not `true`; there's no request payload plus matching hash field; a success has no response body; or a record has `live` but no `http_status`. `--allow-mock` exists only for the selftest, and every output produced with it is stamped `"evidence": "MOCK"`.
- **Both runner schemas are accepted.** Earlier: `result/request_payload/request_hash(sorted canonical)/response`. Current: `status/body/payload_sha256(insertion-order wire bytes)/raw_response` plus `live/dataset_sha256/http_status/provider_id/resolved_model/started_at`. The hash rule follows whichever field is present.
- **Append-only:** the first record per `(case, variant)` counts, and duplicates are listed.
- **Per task×variant:** attempted/answered/not-attempted; correct over attempted (failures count as wrong) and over answered, each with a Wilson 95% interval; confusion matrix (failures shown as `<class>`); per-class recall as `k/n`; balanced accuracy.
- **Paired comparisons** against each of the three baselines: wins/losses and the exact two-sided McNemar p.
- **Failure classes:** `transport`; `schema_or_answer` (HTTP 200 or a parse ValueError, which the runner files under `transport_error`); `other_error`.
- **Latency:** nearest-rank p50/p95/max, count over the production adapter's 10 s deadline, and number of distinct values (a constant column is suspicious). Batched dev latency isn't comparable.
- **Payload checks per record:** exact keys `{model,state,questions}`; pinned model; hash recomputed; state and criteria equal the dataset's (criteria order must be original or reversed, and it's tallied); exactly one question with `{type,instructions,criteria}`; instructions equal the frozen selection on holdout; rationale text isn't in the payload.
- **Attribution:** `provider_id` present/unique counts; the resolved model distribution (absent = unknown, never assumed pinned); `http_status` tally; records whose `dataset_sha256` differs from the supplied dataset's.
- **With `--freeze`:** the dataset digest must equal the freeze's; counts holdout records started before the freeze, or dev records after it.
- **Dev phase:** adds per-task variant correct counts, top-vs-runner-up margin, paired discordance, and `weak_evidence` when margin ≤ 2.

## Blindness

`contract`, `overlap`, and `baselines` print counts, indices, and case IDs only. Dev-majority label names are hidden unless `--show-labels` is passed. The reviewer hasn't printed any lane labels, so the coordinator's `blind-sample.json` (5/task) can still be relabeled blind: `blind-view` first, then write reviewer labels, then `blind-compare`.

## Known limits

- The leakage heuristics are signals, not verdicts. `only_expected_label_named_in_state` skips labels with fewer than 3 characters (e.g. `A`/`B`). `tag_word_in_state` ignores tags carried by more than half a task's cases.
- Overlap uses state values only. Two cases with identical text but different criteria won't be separated by it; `distinct_criteria_sets` covers that.
- Stability/order-reversal records can be scored with `--phase <name>` once the runner fixes that phase name. The criteria-order tally distinguishes original from reversed.
- `infra/runner.py` changed at least twice while this was written. Interop was last confirmed against sha256 `88336e0fd11bb70ff676ba5c702b8268567a4c61967f43d1efe5bf5c02f8fd48`: `payload_digest` matches `wire_digest` for original and reversed criteria order.
