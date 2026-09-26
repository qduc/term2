# V2: evidence lane (E1–E8) assessment

Run `jev-fit-20260919` · task V2 · worker `review` (Claude Code, `claude-opus-5`, self-reported) · 2026-09-19.
Inputs: `evidence/dataset.json` sha256 `f7697a08…d50ccb` (matches the lane receipt), `evidence/baseline.py` sha256 `ac1f618b…077b39`, `review/blind-evidence.json` (40 cases). No scored calls; no lane files modified.

## Summary

The evidence dataset is **structurally sound and usable for the pilot**, with two task-level limitations that cap what their results can mean:

- **E5 (compaction salience) is a narrow/simple fixture.** The salient item is always marked by a type prefix ("Constraint:", "Accepted decision:", "Pending work:", "Required …:"), and distractors carry negative prefixes ("Routine note:", "Irrelevant fact:", "Superseded idea:"). The authored keyword baseline gets **24/24 dev and 24/24 holdout**. Jev results on E5 measure prefix recognition, not semantic salience.
- **E7 (test targeting) has an answer channel in state.** `changed_surface` takes 35 distinct values, and **each maps to exactly one expected class** (e.g. `pure function parser`→ADD_UNIT, `Ink interaction`→ADD_E2E). The authored baseline gets 23/24 dev and 22/24 holdout. Jev results on E7 mostly measure surface-to-class mapping.

Under the preregistered rules, neither E5 nor E7 can reach `promising pilot`: a baseline at 24/24 or 22/24 leaves no room for a significant paired improvement. Their verdicts should carry an explicit fixture limitation. I recommend recording both as "narrow/simple fixture; not evidence of semantic judgment", with no silent re-authoring. A fresh E5/E7 set would need its own new holdout.

## 1. Blind relabel (5 per task, 40 cases)

The procedure, in order:

1. Read `blind-evidence.json` through `audit.py blind-view`, which accepted it: fields `id/task/state/criteria` only.
2. Labeled all 40 from state and criteria alone.
3. Wrote `review/labels-evidence.json` (sha256 `182f0787…ae5ae57`) and `review/labels-evidence-uncertainties.md` (sha256 `c531aeb4…c4b36782`).
4. Only then opened lane labels, via `blind-compare`.

| Task | Agreement |
| --- | --- |
| E1 | 5/5 |
| E2 | 5/5 |
| E3 | 5/5 |
| E4 | 4/5 |
| E5 | 5/5 |
| E6 | 5/5 |
| E7 | 5/5 |
| E8 | 5/5 |
| **Total** | **39/40** |

**Disagreement:** `E4-holdout-020`. State: "A status dashboard says finished but does not distinguish finished from accepted." Frozen label `COMPLETION_UNKNOWN`; reviewer `UNSUPPORTED_CLAIM`. I pre-flagged this case as uncertain before comparing. Both answers are defensible; it turns on whether a dashboard status counts as a completion *claim*. I'd call it an adjudication-sensitive case, not a label defect. Per policy, the frozen label stays.

**How to read 39/40:** high agreement here comes mostly from how easy the cases are, not from careful adjudication of hard ones. Almost every state is one sentence that paraphrases one criterion. Eight of my 40 labels were uncertain; all but one of those still matched. The sample can't show label quality on genuinely ambiguous cases, because the dataset has few of them.

## 2. Contract

`contract` passes with no errors: 8 tasks × 24 dev + 24 holdout = 384, unique IDs, `expected`/`baseline` ∈ criteria, no duplicate states within a split, across splits, or across tasks.

- **Validator change (coordinator-approved, narrow):** `provenance` may now be nonempty text *or* a nonempty object. All 384 cases use `{kind, source, production_evidence:false}`. An empty object is still rejected, and the selftest covers both cases.
- **Criteria sets:** E1 has 2 (separate risk and authorization questions, which addresses protocol-review M8). Every other task has 1.
- **Option position:** perfectly balanced in all tasks (e.g. E2 8/8/8/8/8/8; E5 10/10/10/10/8), so position bias from authoring (M1) is controlled. It looks rotated by construction. That's good for position, but the order-reversal stability trial is still needed to test Jev's sensitivity.
- **Class balance:** the dev-majority baseline gets 4–6/24 per task, consistent with near-uniform classes. For E1 the dev-majority label belongs to one dimension, so 12 cases are marked `inapplicable` (scored wrong). That's correct handling.

**Leakage heuristics (11 flags, all inspected):**

- `only_expected_label_named_in_state` (10):
  - 8 are E7 `NO_SUPPLEMENTAL` cases. They fire only because every E7 state includes the boilerplate "select only supplemental coverage". That's a weak signal and not a leak on its own; the real E7 channel is `changed_surface`, covered above.
  - `E1-dev-012` ("…overwrite behavior are unknown" → RISK_UNKNOWN) and `E3-dev-017` ("emits an unchanged failure" → UNCHANGED_FAILURE) are direct paraphrases. Mild and realistic, no action.
- `tag_word_in_state` (1): `E3-dev-011` uses "ambiguous" descriptively. Benign.

## 3. Overlap (char 5-gram Jaccard on state values; flag ≥ 0.6)

| Task | holdout→nearest dev (median / max) | flagged pairs | template_ratio |
| --- | --- | --- | --- |
| E1 | 0.116 / 0.221 | 0 | 0.0 |
| E2 | 0.068 / 0.277 | 0 | 0.0 |
| E3 | 0.079 / 0.166 | 0 | 0.0 |
| E4 | 0.084 / 0.266 | 0 | 0.0 |
| **E5** | **0.624 / 0.696** | **19** | **0.771** |
| E6 | 0.088 / 0.184 | 0 | 0.0 |
| E7 | 0.392 / 0.495 | 0 | 0.0 |
| E8 | 0.073 / 0.230 | 0 | 0.0 |

**E5 is shared scaffold, not semantic duplication** (coordinator's question):

- The `objective` sentence is identical in all 48 cases.
- The distractors come from a small pool: 192 candidate slots hold 84 distinct strings, and 8 distractors appear 10–11 times each. On distractor text alone, the holdout→dev nearest-neighbour median is 1.0.
- The **salient item doesn't repeat**. 0/20 holdout gold texts equal a dev gold text, and the gold-only nearest-neighbour median is 0.122. With the objective removed, candidate text overlap drops to a median of 0.523.
- So the 19 flagged pairs are reused distractors and objective, not twin cases. The dev/holdout split is genuine for the part that matters. The limitation is **triviality** (the prefix channel), not leakage between splits.

E7's elevated overlap (0.39 median) is the fixed `required_gates` sentence present in every state. That's scaffold too.

## 4. Baselines

Correct out of 24 per split:

| Task | Authored dev | Authored holdout | Lexical dev | Lexical holdout | Dev-majority holdout |
| --- | --- | --- | --- | --- | --- |
| E1 | 19 | 11 | 12 | 11 | 4 (12 inapplicable) |
| E2 | 16 | 9 | 14 | **15** | 4 |
| E3 | 10 | 7 | 8 | 6 | 6 |
| E4 | 10 | 7 | 10 | 7 | 6 |
| E5 | **24** | **24** | 5 | 5 | 5 |
| E6 | 13 | 5 | 15 | **11** | 4 |
| E7 | 23 | **22** | 4 | 4 | 4 |
| E8 | 11 | 8 | 17 | **11** | 4 |

- **Reproducibility is confirmed.** `evidence/baseline.py:predict_case` reproduces the stored `baseline` field for **384/384** cases when it's given only `{neutral id, task, state, criteria}`. No crashes, and no process, network, or nondeterminism patterns.
- **Line 169 is not predictor leakage.** The AST scan attributes the only label-field read to `main()` line 169: `case["baseline"]` (the stored baseline, not `expected`), used in the `--check` CLI comparison. It's unreachable from `predict_case`. I made the audit's static scan function-aware so it no longer flags this (selftest covers both a CLI-only read and a label read in a helper reachable from the predictor).
- **The authored baseline drops sharply from dev to holdout** (E1 19→11, E2 16→9, E6 13→5, E3/E4/E8 −3). The keyword lists were fitted to dev phrasing. That's legitimate for a heuristic, and it's mild evidence that holdout wording genuinely differs from dev. But the authored baseline is **not the strongest holdout baseline** for E2, E6, E8: the independent lexical probe beats it (15, 11, 11).
- **Recommendation:** per the preregistration ("strongest valid simple baseline"), report Jev's paired result against all three baselines, and use the per-task maximum as the superiority bar. Picking the strongest baseline on holdout is conservative against the model, so it doesn't bias in Jev's favour.

## 5. Implications for E-lane verdicts

| Task | Dataset assessment | Verdict ceiling / condition |
| --- | --- | --- |
| E1 approval | Sound; risk and authorization separate; short states | Advisory only regardless of score. Report false AUTHORIZED / false low-risk counts individually. |
| E2 triage | Sound | Superiority bar = lexical 15/24 |
| E3 progress | Sound | Bar = authored 7/24 |
| E4 completion | Sound; E4-holdout-020 adjudication-sensitive | Report sensitivity with and without that case |
| **E5 compaction** | **Narrow/simple fixture: prefix-solvable, baseline 24/24** | At best `conditional fit` scoped to "prefix-marked candidates"; can't show semantic salience |
| E6 notification | Sound | Bar = lexical 11/24 |
| **E7 test targeting** | **`changed_surface` answer channel; baseline 22/24** | At best `conditional fit` scoped to "labelled change surface"; superiority unreachable |
| E8 offline eval | Sound; states restate criterion definitions | Bar = lexical 11/24; note self-referential rubric |

**Lane-wide limitations:**

- One-sentence states, so there's no long-context or noisy-state evidence.
- Author-visible holdout.
- The blind sample can't validate hard-case labels.
- None of this blocks running the lane. It bounds the claims.

## Not done

- No scored calls; no Jev output inspected.
- Routing and discovery lanes not assessed in V2.
- Grok challenge cases not assessed.
