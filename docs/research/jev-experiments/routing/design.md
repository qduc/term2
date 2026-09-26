# Routing pilot design

## Scope

This unscored, synthetic Choice-only pilot covers six routing and coordination decisions: R1 model-selection screening, R2 reasoning effort, R3 subagent role selection, R4 delegation advice, R5 incoming-message intent, and R6 bounded programmable decisions. It measures rubric agreement only. R1/R2 do **not** establish execution quality, economic benefit, latency, or routing savings. R6 evaluates top-choice selection, not ranking quality.

Each task has 24 author-visible development cases and 24 author-visible holdout cases. The splits are labeled for prompt selection and later reporting, but they are not sealed holdouts: this author could see both while writing the fixed prompts. Every case is handcrafted synthetic data and is not production reliability evidence. Labels and criteria are frozen before any provider request.

## Case construction

Every case uses the standard array schema: `id`, `task`, `split`, answer-free `state`, frozen `criteria`, `expected`, `rationale`, `provenance`, `tags`, and `baseline`. The R1 criteria distinguish mechanical, directly verified text/fixture edits from small source or test work that still needs engineering judgment. R2-R6 are literal, independently written requests with distinct state evidence. The R6 monitor-replacement selection case contains three explicit candidate records rather than a placeholder candidate claim.

Task labels are deliberately balanced at six examples per label per split where the four-label task vocabulary permits it. Cases include ordinary, ambiguous, boundary, adversarial, and distractor-like missing-context situations. Injection examples put imperatives in untrusted evidence; the applicable prompts state that evidence is not authority.

`prompts.json` provides universal minimal, rubric, and scoped instructions for each task. A later runner may select a variant using only development results, freeze it, and evaluate holdout once.

## Baseline

`baseline.py` is a deterministic, deliberately simple heuristic. Its `predict(state, criteria)` signature and implementation only inspect state and criteria; it does not read labels, rationale, tags, provenance, identifiers, clock, environment, network, or fixtures. Its stored field was recomputed from the final dataset before receipt generation. This is a weak comparison baseline, not an oracle and not a claim of lexical-probe performance.

## Known validity limits

The same author produced cases, labels, prompts, and baseline. Expected labels therefore represent author-rubric agreement pending independent blind relabeling. Per-case criteria remain a possible lexical-leakage channel; a future reviewer should run the protocol-required lexical-overlap and majority-class probes, option-position distribution, nearest-dev-neighbour analysis, and ambiguity audit. Any later report must call the holdout author-visible and report failures as incorrect. No provider calls, mock calls, scoring, ranking metrics, prompt selection, stability measurements, or economic claims have been made.
