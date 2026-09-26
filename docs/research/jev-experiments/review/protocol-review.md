# V0 protocol review: threats to validity

Run `jev-fit-20260919`, task V0, worker `review`. Reviewer route: Claude Code harness, model `claude-opus-5` (self-reported by the harness system prompt; not independently attested).

Scope reviewed (2026-09-19): `docs/research/jev-experiment-protocol.md`, `docs/research/jev-decision-model-opportunities.md`, the five briefs in `jev-experiments/briefs/`, and the wire reference `source/providers/openrouter-decisions.ts`. At review time no lane had produced a dataset, prompts, baseline, or runner; `infra/ack.json` was the only other lane artifact. Findings below are about the **design as written**. Findings about data and runner are listed as pending checks (see `review.md`), not as observed defects.

Severity: **High** = can make a headline result wrong or unfalsifiable; **Medium** = weakens or biases a result; **Low** = reporting/hygiene.

## 1. Answer leakage

**H1 (High). Per-case `criteria` is a leakage channel.** The dataset contract allows each case to carry its own `criteria` map, and the same author writes `state`, `criteria`, and `expected`. An author can (unintentionally) phrase only the correct option's description in the vocabulary of the state, so any lexical matcher, Jev included, wins without doing the judgment. Instructions are held constant across a task; criteria aren't, so the thing under test can differ per case.
*Required:* per task, report how many distinct criteria sets exist. Where criteria vary per case, run an independent lexical-overlap probe (below) and flag cases where only the expected option overlaps the state.

**H2 (High). Non-state fields could reach the payload.** `rationale`, `tags` (e.g. `adversarial`, `ambiguous`), `provenance`, `baseline`, `expected`, and even `id` (e.g. `D1-dev-none-03`) all carry label information. The wire format is `{model, state, questions}` where a question is `{type, instructions, criteria}`; nothing else may be sent.
*Required:* recompute a sample of request payloads from dataset + frozen prompt and compare against the logged payload hash; grep logged payloads for every `expected` label appearing outside the criteria keys, and for tag/rationale strings.

**M1 (Medium). Option order.** `criteria` is a JSON object, so option order is author order. If `expected` tends to be the first (or last) key, position bias inflates or deflates results. Protocol step 6 asks for order balancing, but the runner contract in `briefs/infra.md` doesn't implement permutation.
*Required:* report the position of `expected` among criteria keys per task. If it's skewed, the protocol's order-balance subset is mandatory, not optional.

**M2 (Medium). Label-named state keys.** A state like `{"is_destructive": true, ...}` or `{"authorized_by_user": "no"}` precomputes the answer. This is realistic for some seams (typed failures in E2) but makes the case a lookup, not a semantic judgment.
*Required:* flag state keys or values that equal or trivially negate a criteria label.

## 2. Synthetic, trivial, and author-biased examples

**H3 (High). The same worker writes cases, labels, prompts, and baseline.** That's four roles in one mind, all concurrent. Expected consequences: cases that are easy for LLMs of the author's family, templated near-duplicates, and labels that encode the author model's judgment. Per the opportunity doc, agreement with an LLM reviewer "is a compatibility metric, not ground truth". Authors here are GLM-5.3-flash (D) and GPT-5.6 (R, E), not humans, so `expected` is *author-model agreement* unless independently adjudicated.
*Required:* (a) blind relabel of a stratified sample (target ≥ 20% per task, weighted toward `ambiguous`/`boundary`/`adversarial` tags) by the reviewer, without seeing `expected`; report agreement and list disagreements. (b) Report headline accuracy both on all cases and on the reviewer-agreed subset.

**M3 (Medium). Triviality isn't measurable from exit status.** A task where a bag-of-words matcher gets ~95% tells you nothing about Jev.
*Required:* the reviewer runs an independent **lexical probe** (token overlap between state and each criteria description, argmax; ties → first key) and a **majority-class baseline**. Both use only `state` and `criteria`. If either is within a few cases of Jev, the task is too easy to discriminate.

**M4 (Medium). "Adversarial" cases may be adversarial only by tag.** An injection string that just says "ignore instructions" is a weak test. The opportunity doc names documented Jev weaknesses: literal interpretation, counting/dates, indirection, irrelevant context. Adversarial cases should target those.
*Required:* tabulate adversarial cases by mechanism (injection in state, indirection, arithmetic/date, long distractor context, negation); report per-mechanism counts and errors.

## 3. Dev/holdout separation

**H4 (High). Holdout isn't hidden from the prompt author.** Each lane authors dev, holdout, and prompts at the same time. Step 5 ("tune only on development cases") can't be enforced once the author has read the holdout; prompt wording can absorb holdout knowledge without any holdout query. So this is an **author-visible holdout**, and it supports weaker generalization claims than a sealed one.
*Required:* call it that in every verdict. A stronger design (recommended if a claim matters): a different worker authors a fresh holdout after freeze.

**M5 (Medium). "Differ in substance, not merely in names" has no test.**
*Required:* for each holdout case, compute its nearest dev neighbour (character 5-gram Jaccard over canonicalized `state` + criteria) and report the distribution. Flag pairs above ~0.6 as likely templated twins. Also compare dev vs holdout label and tag distributions; a holdout that's easier (more `ordinary`) inflates generalization.

**H5 (High). Label freeze has no temporal proof.** "Freeze labels before querying Jev" is only verifiable if a dataset digest is recorded *before* the first dev call and every dev record carries that digest. Otherwise dev labels can be quietly "corrected" after seeing Jev's answers, which inflates dev accuracy and biases variant selection.
*Required:* the lane receipt's `dataset.json` sha256 must predate the first dev JSONL timestamp, and every dev/holdout record must carry an identical dataset digest. Any change means dev is re-run, or the change gets logged as a consumed/modified split.

**M6 (Medium). Variant selection on 24 dev cases is mostly noise.** Picking the best of three variants on n=24 selects the lucky one. The fixed tie order (scoped > rubric > minimal) biases toward `scoped` when differences are 0–1 cases.
*Required:* report paired discordant counts between variants on dev. Treat a selection margin of ≤ 2 cases as "no evidence of a difference" and say so. Retain all losing-variant results (protocol step 5 already says this).

## 4. Baseline reproducibility

**H6 (High). The `baseline` field is precomputed by the author.** The contract stores `baseline` in `dataset.json` *and* requires `baseline.py`. If the two diverge, or the field was hand-set, the baseline is an oracle or a strawman.
*Required:* rerun each lane's `baseline.py` and diff its output against the stored field byte-for-byte. Statically check that `baseline.py` reads only `state` and `criteria`: no `expected`, `rationale`, `tags`, `provenance`, or `id`. Also no randomness, clock, network, or env dependence, and no execution of fixture commands (`subprocess`, `os.system`, `eval`, `exec`).

**M7 (Medium). Strawman risk.** A baseline like "always `none`" or "always high risk" makes any model look good.
*Required:* compare the lane baseline against the reviewer's majority-class and lexical probes. If the lane baseline is worse than majority-class, call it a strawman and use the stronger baseline for the headline comparison.

## 5. Ambiguous labels

**H7 (High). Single `expected` vs required ambiguous cases.** The contract requires "ambiguous/unknown" examples but allows exactly one `expected`. That's coherent only when the criteria include an explicit `unknown`/`none`/`insufficient_evidence` option *and* the ambiguous case's expected is that option. If an ambiguous case is labelled with a substantive option, it's a contestable label, and scoring it as an error is scoring the author's tie-break.
*Required:* for every case tagged ambiguous, check that an abstain-type option exists and that `expected` is it, or that the rationale explains why the ambiguity resolves. Score contestable cases separately.

**M8 (Medium). E1 must stay split.** The protocol requires risk and authorization to be judged separately, and `evaluateDecisionShadow` asks them as separate questions. A single-`expected` case with labels like `approve`/`deny` collapses two judgments and hides which one failed.
*Required:* E1 cases should be single-question risk *or* authorization cases (or paired cases with a shared state digest). False approvals get reported as absolute counts per challenge class: destructive effect, authorization ambiguity, injection.

**M9 (Medium). R1/R2 labels are subjective by construction.** The protocol already restricts them to "routing-label screening". Verdicts for R1/R2 must say "rubric agreement only; economic benefit untested", since there's no fixed-vs-routed execution stage in the briefs.

## 6. Skewed and misleading metrics

**M10 (Medium). Accuracy under class imbalance.** With ~24 cases and several classes, one dominant class makes accuracy meaningless.
*Required:* per task, report class counts, confusion matrix, per-class recall *with numerator/denominator*, balanced accuracy (macro recall), and majority-class accuracy. Don't pool accuracy across tasks with different option sets.

**M11 (Medium). Small-n uncertainty.** At n=24, 20/24 = 83% has a 95% Wilson interval of about [64%, 93%]. A paired comparison against the baseline is significant (exact McNemar, two-sided α=0.05) only with lopsided discordance, e.g. 6–0 or 8–1.
*Required:* report Wilson intervals and paired discordant counts (Jev-right/baseline-wrong vs the reverse). Don't turn percentage differences into verdicts without them. Per-class recall on 2–4 examples should be shown as counts only.

**M12 (Medium). Failure exclusion (survivorship).** If transport or schema failures are dropped from the denominator, and they correlate with case properties (long state near the 32k OpenRouter limit, unusual characters), accuracy gets biased upward.
*Required:* report accuracy over *attempted* cases (failure = wrong) and over *answered* cases, plus the failure list with case IDs and state sizes.

**M13 (Medium). Latency/usage aren't comparable across phases.** Dev may batch three variants into one request while holdout sends one. So per-request latency and usage differ by construction, and batched usage can't be split per variant. Also, the runner timeout is 60 s but the production adapter's deadline is **10 s** (`requestOpenRouterDecisions`, `timeoutMs = 10_000`).
*Required:* report latency only from single-question holdout requests (label n). Report the fraction of calls that would have exceeded the 10 s production deadline. Don't report per-variant cost from batched calls. Mark p95 from < 40 samples as indicative only.

**L1 (Low). Retrieval tasks are top-1 Choice.** The briefs already forbid ranking metrics. Verdicts for D2–D6 must not imply recall@k/NDCG, and no-fit precision needs its own count.

## 7. Evidence of real network responses

**H8 (High). Mock and live records have to be separable, and live records attributable.** The runner has a mock selftest. Any aggregate that could include mock output is contaminated.
*Required, per live record:* HTTP status; response body retained raw (sanitized); provider request/generation identifier if returned (e.g. OpenRouter `id`); the response's `model` field if present (must match the pinned `typesafe/jev-1.13` or be recorded as a resolved variant; missing = unknown, not assumed); wall-clock start/end; payload sha256. Checks:
- mock records are flagged and stored separately, and `report` refuses them;
- durations are plausible and non-constant (a column of identical or ~0 ms durations means fabrication or mocking);
- IDs are unique and timestamps are consistent with concurrency ≤ 4;
- recomputed payload hashes match;
- attempt counts show no silent retries;
- `smoke.json` is a real response with the same shape as the scored records.
If a credential is available to the coordinator, spot-checking a few generation IDs against the provider's own record is the strongest attribution; the reviewer won't use credentials.

**M14 (Medium). The runner isn't term2's code path.** A stdlib Python runner shows **API behaviour**, not term2 integration behaviour (timeouts, abort, validation in `decision-shadow.ts`). Verdicts should say "provider-level pilot".

**M15 (Medium). Route/identity mismatch with the protocol.** The protocol proposes 3× GPT-5.6 Terra + 1× Sol reviewer via Codex. The briefs actually assign GLM-5.3-flash (D), Terra (R, infra), Sol (E), and a Claude reviewer. `infra/ack.json` records `route_verified: false`. That's fine for research, but the synthesis should record actual worker routes, since the author model shapes dataset difficulty (H3).

## 8. Confidence misuse

**H9 (High). Confidence isn't calibrated probability of correctness.** The opportunity doc says so explicitly. Risks: reporting mean confidence as a quality signal; thresholding on confidence (e.g. "auto-approve if confidence > 0.9") without a dev-tuned, holdout-tested threshold; combining risk and authorization by `min(confidence)` and reading it as joint safety.
*Required:* any confidence threshold is chosen on dev and evaluated once on holdout, reported as a coverage-vs-accuracy (selective prediction) table with counts. No calibration claims at n=24 per task. For E1, report whether any false approval came with high confidence; that's the dangerous quadrant.

**M16 (Medium). The runner contract drops the probability distribution.** The infra brief records "raw choice/confidence". The opportunity doc says to preserve distributions. If the response includes per-option probabilities, the raw body must be kept so abstention and threshold analyses can be redone.

## 9. Gaps between protocol and briefs

| Protocol requirement | Brief/runner status | Consequence |
| --- | --- | --- |
| Step 6: repeat a predeclared subset for stability | Not in runner contract | No stability evidence unless added; say so |
| Step 6: balance answer order | Not in runner contract | Position bias unmeasured (see M1) |
| Step 4: Score/Noul where appropriate | Briefs restrict to Choice | Fine for comparability; verdicts can't generalize to other primitives |
| Metrics: prompt-injection testing for authority advisories | Briefs require "adversarial" tags only | Check E1/E4 include real injection mechanisms (M4) |
| Routing economics needs fixed vs routed execution | Not assigned | R1/R2 economics = **untested** |
| Verdict vocabulary | No predeclared thresholds | Verdicts risk being post hoc (below) |

**H10 (High). Verdict thresholds aren't predeclared.** `promising pilot` vs `conditional fit` vs `inconclusive` has no numeric or evidential criterion, so verdicts can be fitted to results.
*Recommended before any holdout run:* the coordinator records, per task, the minimum evidence for each verdict, e.g. holdout balanced accuracy vs strongest baseline with a paired discordance margin, zero false approvals for E1 as necessary-but-not-sufficient, abstention recall on no-fit cases. Write it into the freeze artifact or a separate dated file whose digest predates holdout.

## 10. Things the design gets right

- Explicit freeze/holdout-consumption rule, retained losing variants, separation of transport vs task errors, and a ban on manufactured costs/latency.
- A clear statement that pilot accuracy isn't production reliability, and that zero errors at small n can't authorize activation.
- Routing economics correctly marked untested without execution.
- Disjoint directories and a coordinator recomputation step.
