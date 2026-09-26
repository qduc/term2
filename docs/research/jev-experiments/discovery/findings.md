# D1 findings (frozen run jev-fit-20260919)

Status: **final for this run** · Sources: frozen logs in `results/dev.jsonl`, `results/holdout.jsonl`, `results/stability.jsonl` against frozen `dataset.json` (sha256 `9b0ddebc…30adc`); baseline comparison reproduced with `python3 review/audit.py baselines discovery/dataset.json --baseline-script discovery/baseline.py` (aggregate in [../aggregate/discovery/baselines.json](../aggregate/discovery/baselines.json)); blind review in [../review/v4-discovery-d1.md](../review/v4-discovery-d1.md) and [../review/v4-discovery-routing.md](../review/v4-discovery-routing.md) §4.

## Headline numbers

| phase | records | result |
|---|---|---|
| dev (3 variants × 24) | 72 live, 72 success, 0 transport errors | minimal **22/24**, rubric **23/24**, scoped **23/24** |
| holdout (frozen variant) | 24 live, 24 success | scoped **21/24** (Wilson 0.69–0.96) |
| stability (repeat + reversed) | 4 live, 4 success | **4/4**, both predeclared cases order-invariant |
| authored lexical baseline (baseline.py, holdout) | — | **14/24** (reproduced 48/48 from state+criteria; static scan clean) |
| independent lexical probe (strongest preregistered, holdout) | — | **16/24** (also 16/24 on dev) |

The preregistered superiority bar for D1 was the lexical 16/24. Frozen scoped exceeds it 21 vs 16, a **6–1 win/loss record with exact McNemar p = 0.125 — weak evidence of superiority, not significant at n=24**. Against the authored baseline (14/24, 8–1) the paired test is significant (p = 0.039), but the authored heuristic is the weaker of the two preregistered comparators.

## Position confound (conditional result)

The expected label is the first criteria key in **33/48** cases (dev 16, holdout 17; state.candidates shares that order in 48/48), so headline accuracy is **position-confounded**. Post hoc splits from the review: the frozen model is **16/17 when the answer is listed first** and **5/7 when it is not** (it picks the first-listed option in 18/24 holdout cases); a post hoc position-only diagnostic scores **17/24** (paired record 5–1, p = 0.22). The not-first subset (7 cases) cannot separate task understanding from position preference, and the reversed-order stability trial covers only 2 cases. Review verdict, which this worker adopts: **"conditional fit, position-confounded; abstention not established."** Any successor run must balance criteria order before scoring.

## Selected variant

Dev ended rubric 23 = scoped 23 > minimal 22, with rubric and scoped sharing identical failure sets — a margin of 0 broken by the predeclared tie order (scoped). Per the review: **weak evidence** for scoped; dev does not discriminate rubric from scoped, and the holdout 21/24 is not evidence that scoped beats rubric. The exact selected prompt is recorded in [freeze.json](freeze.json) (`selected_variants.D1 = "scoped"`, `selected_instructions.D1`), the authoritative copy, byte-identical to prompts.json → D1.scoped.instructions.

## Failed cases (scoped/frozen variant unless noted)

### d1-dev-21 — "Clean up this data." → chose data-cleaning, expected insufficient_evidence

Failed by **all three variants**. The request lexically names a plausible skill and the state is empty; the model accepted the request's frame instead of demanding the referent. Prompt lesson: even the scoped variant's insufficient_evidence rule did not overcome a lexically invited default. State lesson: a refusal case works only when the missing evidence is *salient*. This is the recurring failure pattern of the run (it also produced two of the three holdout misses).

### d1-holdout-12 — digest 90-minute all-hands recording → chose none, expected transcription

The only miss among concrete tasks, an under-selection. transcript_available: false was meant to prove summarization inapplicable, but the model concluded condensing a recording needs no cataloged skill. Lesson: the "enabler skill" boundary is underdetermined by catalog descriptions, and the none criterion ("no listed skill clearly applies") invited treating transcription as optional machinery.

### d1-holdout-20 — "Improve the docs." → chose technical-writing, expected insufficient_evidence

Over-commitment on a vague request (model confidence 0.43). Same pattern as d1-dev-21: the model's bar for acting is lower than the author's. Review note: on such cases none is also literally true under its generic wording, so these labels are adjudication-sensitive.

### d1-holdout-21 — "Something's been broken since yesterday." → chose incident-debugging, expected insufficient_evidence

Identical pattern, third instance (confidence 0.53). Two of three holdout misses plus the recurring dev miss are the same refusal-threshold failure. The review characterizes this as over-commitment on vague requests — the costly direction for skill suggestion — and notes abstention is established on only 1/3 holdout vague cases.

## Blind review status

The blind relabel is **complete at 5/5** for D1 (review/labels-discovery.json, hashed before discovery files were opened; both pre-flagged medium-confidence cases and both adversarial cases matched). **This does not resolve all specific failed-case labels**: the 5-case sample does not adjudicate d1-dev-21 or the three holdout misses, and the review explicitly flags the vague-request cases as label-sensitive (none vs insufficient_evidence wording overlap). Headline claims therefore remain "agreement with frozen author labels," with the refusal-threshold cluster still open to adjudication. The review also found none is expected in 0 holdout cases, so abstention-to-none is untested on holdout.

## Limits of this top-1 synthetic pilot

- **Top-1 only.** Choice accuracy says nothing about ranking quality; no full-ranking metrics are claimed.
- **Position confound.** 33/48 expected-first cases; the gain over the strongest preregistered baseline is not significant (McNemar p = 0.125), and the post hoc gain over the position-only diagnostic (5–1, p = 0.22) is concentrated in the answer-first subset. The result cannot be distinguished from ordering behavior.
- **n=24 per split per variant** cannot separate rubric from scoped (margin 0, tie rule decided); dev provides only weak evidence about variant choice.
- **Skill catalogs are invented per case** and criteria quote candidate descriptions verbatim, which makes lexical matching easy; transfer to a real catalog is untested.
- **Stability coverage is 2 cases × 2 orders**, both chosen by tag; too small to test order sensitivity.
- **Abstention untested for none on holdout** (0 expected-none holdout cases); insufficient_evidence abstention is weak (1/3).

## What would change the conclusions

1. Adjudication of the refusal-threshold cluster (d1-dev-21, d1-holdout-20, d1-holdout-21) — if labels flip, the story changes from "model acts too readily" to "author refusal bar too strict."
2. A successor dataset with balanced criteria order (the routing lane's perfect balance shows the fix is practical) and a larger dev split before further variant comparison.
3. Holdout cases with expected none to test no-fit abstention.
