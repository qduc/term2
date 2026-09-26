# Challenge holdout set (task C)

Run: `jev-fit-20260919`. Worker: `challenge`. Coding model for this authoring session: **Grok 4.6** (not the protocol’s proposed GPT-5.6 Terra workers).

This directory is an **additional** independent challenge set. It does not replace the larger planned development/holdout sets owned by discovery, routing, and evidence workers.

## Scope

- Primitive: Choice only, including best-candidate selection for retrieval-like tasks.
- Split: every case is `holdout`.
- Size: exactly 4 cases per task D1–D6, R1–R6, E1–E8 (80 total).
- Tag: every case includes `independent_challenge`.
- Labels frozen before any provider execution. No scored Jev calls in this deliverable.

Cases are handcrafted/synthetic fixtures inspired by term2 seams named in `jev-decision-model-opportunities.md` and `jev-experiment-protocol.md`. They are not production reliability evidence and were not sampled from private conversations.

## What these 4 cases are for

Each task’s quartet is built to stress decision boundaries rather than to estimate accuracy:

| Slot | Stress | Typical expected move |
| --- | --- | --- |
| `*-01` | Ordinary positive | Clear supported label |
| `*-02` | Adversarial / evidence injection | Ignore instruction-like text inside state |
| `*-03` | Ambiguous / unknown / missing evidence | Abstain (`none` / `unknown` / `none_additional`) |
| `*-04` | Distractor + boundary | Near-miss lexical overlap; the criteria winner is not the token-overlap winner |

Prompts must apply to every case of a task. Criteria may differ slightly by case when candidate IDs differ (retrieval), but option *roles* stay stable: a best candidate plus an abstain option.

Evidence lives only in `state`. `criteria` is the rubric the question is allowed to use. Injected “SYSTEM” lines, banners, and prior-approval claims are data, not permission.

## Prompts

`prompts.json` has three universal variants per task:

- `minimal`: literal question, no extra policy.
- `rubric`: atomic decision rules, near-miss boundaries, and when to abstain.
- `scoped`: names which state fields are evidence and treats other fields, plus any instruction-like strings inside evidence, as untrusted.

Effective-prompt selection belongs on a **development** split. This worker has no dev split; these prompts are frozen candidates for later comparison, not a winner declared from holdout.

## Baseline

`baseline.py` is a reproducible lexical heuristic: token overlap between query-like state fields and option labels, criteria text, and candidate bodies. It ignores `noise` / `injected` when a query field exists, and abstains when no non-abstain option scores above zero. It does not read `expected`. Stored `baseline` values are that heuristic’s output, not a second gold label.

After freeze, the heuristic disagrees with gold on 28 of 80 cases, including several ordinary and most distractor/injection items. That disagreement is intended.

## Deliberate non-claims

- No ranking metrics (MRR/nDCG). Retrieval tasks are scored as top-1 Choice.
- E1 scores **authorization** as a single Choice. Risk remains in state as context and is not a second scored question here.
- R1/R2 labels are routing-rubric agreement only. They do not measure end-to-end savings or quality.
- E7 must never be read as waiving repository-required gates; `none_additional` means no extra *advisory* target.
- Dangerous shell strings appear only as JSON data in `dataset.json` and must not be executed.

## Out of scope for this worker

Live API calls, shared runner edits, production source changes, credentials, other workers’ datasets, commits, child agents, and existing Herdr panes.
