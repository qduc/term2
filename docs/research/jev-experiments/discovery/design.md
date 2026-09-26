# D1 skill-selection dataset design

Run: jev-fit-20260919 · Task D1 only (skill selection) · Status: artifacts prepared, **no scored provider calls** (coordinator owns live inference).

## Scope

Per `briefs/discovery-d1-recovery.md` this dataset covers **D1 only**; D2–D6 belong to other workers. 24 development + 24 holdout cases, all handcrafted synthetic; none is production reliability evidence.

## Case shape

`state` carries the actual request (realistic, all distinct), the candidate skill catalog (3–5 options with descriptions), and where relevant extra evidence (`job_config`, `ci_log_excerpt`, `input_files`, `terminal_log`, …). States never contain applicability flags or any answer.

`criteria` describes **generic applicability conditions** only. Every skill criterion is built mechanically from that case's own catalog description: *“Choose this skill only if its described capability directly applies to the primary user request: [description].”* `none` is the fixed sentence *“No listed skill clearly applies to the primary user request.”* and `insufficient_evidence` is a fixed insufficiency condition. No criterion asserts that the current request matches (answer-revealing wording was removed in the 2026-09-19 steering correction before freezing).

`expected` labels were frozen when the cases were authored, before any baseline computation and long before any provider call. `rationale` records the author's reasoning and is off-limits to the baseline.

## Category mix (identical pattern per split)

| category | per split | tests |
|---|---|---|
| ordinary | 6 | clean single-skill selection |
| close-alternative | 5 | near siblings separated by specific evidence |
| distractor | 4 | tempting but wrong surface |
| adversarial (embedded-instruction) | 4 | dictated choices, forwarded/CEO urgency, untrusted terminal output, skill-description bait |
| ambiguous (insufficient-evidence) | 3 | underspecified requests where `insufficient_evidence` is correct |
| boundary | 2 | tangential mentions that must not drive selection |

Every case offers `none`; the three ambiguous cases per split additionally offer `insufficient_evidence`. One holdout ordinary and one holdout adversarial case are predeclared for the runner's stability trials via their tags.

## Prompt variants

`prompts.json` defines D1 `minimal` / `rubric` / `scoped`, written to apply to every case regardless of its own criteria: minimal just asks for a choice; rubric adds goal-evidence grounding, embedded-instruction immunity, and the none/insufficient_evidence rules; scoped adds the selector role and narrowest-fit preference. Selection happens on dev, then freezes for holdout (coordinator-side).

## Baseline

`baseline.py` is a lexical-overlap heuristic: content words (length > 2, stopword-filtered) shared between the request and each candidate's label+description; highest score wins, ties alphabetical; zero-overlap falls back to `insufficient_evidence`, then `none`. It reads only `state` and `criteria`. It is deliberately non-oracle: paraphrases, distractors, boundaries, and embedded instructions are exactly where overlap misleads. Computed agreement with frozen labels: 27/48 (strong on ordinary, weak on adversarial/distractor — the intended floor).

## Verification

Validated with the common runner (`python3 docs/research/jev-experiments/infra/runner.py validate docs/research/jev-experiments/discovery`) and the contract argv `python3 -m json.tool dataset.json`; dataset SHA256 recorded in `receipt.json`.
