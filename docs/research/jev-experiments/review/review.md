# V0 review — initial report

Run `jev-fit-20260919` · task V0 · worker `review` · route: Claude Code harness, model `claude-opus-5` (self-reported). Date 2026-09-19.

**Status:** protocol reviewed. Lane datasets, prompts, baselines, and the shared runner didn't exist when this was written, so **nothing has been verified yet**. This report hands the next review pass a checklist. It doesn't accept any lane artifact. Full reasoning is in [protocol-review.md](protocol-review.md).

## Verdict on the design

The design works for a **screening pilot**, as long as the high-severity items below are handled or explicitly disclosed. Without that, headline results could be wrong or unfalsifiable. The most important ones:

1. **H4: the holdout is author-visible.** Every lane writes dev, holdout, and prompts together. Generalization claims must say "author-visible holdout". A sealed or fresh holdout from a different author is the fix if a claim matters.
2. **H5: no temporal proof of the label freeze.** A dataset digest has to predate the first dev call, and every scored record must carry it.
3. **H1/H2: leakage through per-case criteria and non-state fields.** Payloads must contain only `state`, `instructions`, `criteria`. Per-case criteria get a lexical-overlap probe.
4. **H3/H7: labels are author-model judgments, and ambiguous cases need an abstain option.** The reviewer will blind-relabel a stratified sample.
5. **H6: the stored `baseline` field must equal `baseline.py` output**, and `baseline.py` must read only `state`/`criteria`.
6. **H8: live responses must be attributable** (status, raw body, provider id, response model, timings, payload hash), with mock records segregated.
7. **H9/M16: confidence isn't calibration.** Thresholds get tuned on dev only, and raw distributions are preserved.
8. **H10: predeclare verdict thresholds before any holdout run.**

## Checks to run when artifacts land (no polling; run on coordinator hand-off)

Dataset (per lane `dataset.json`):
- [ ] Schema, unique global IDs, ≥ 24 dev + 24 holdout per task, `expected` and `baseline` ∈ criteria keys.
- [ ] Payload fields: no `expected`/`rationale`/`tags`/`id` text inside `state`. State keys/values that equal or negate a label get flagged (M2).
- [ ] Distinct criteria sets per task; lexical-overlap probe accuracy (M3/H1).
- [ ] Position of `expected` among criteria keys (M1).
- [ ] Dev→holdout nearest-neighbour 5-gram Jaccard; label/tag distributions by split (M5).
- [ ] Ambiguous-tagged cases have an abstain option and `expected` is it, or the rationale justifies otherwise (H7).
- [ ] E1 keeps risk and authorization as separate judgments (M8). Adversarial cases tabulated by mechanism (M4).
- [ ] Blind relabel of ≥ 20% stratified sample; agreement and disagreement list (H3).
- [ ] Majority-class baseline per task (M7).

Baseline:
- [ ] Rerun `baseline.py`; diff against stored `baseline` field (H6).
- [ ] Static read: only `state`/`criteria`; no randomness, clock, network, env, or subprocess/eval (H6).

Runner / freeze:
- [ ] Recompute sample payload hashes from dataset + prompts; payload holds only `{model, state, questions}` (H2).
- [ ] Dataset digest in lane receipt predates first dev record; all records carry the same digest (H5).
- [ ] Freeze file lists selected variant + digests, written after last dev record and before first holdout record. Holdout uses only that variant.
- [ ] Selection margin reported as paired discordance; ≤ 2 cases = no evidence of difference (M6).
- [ ] Mock records segregated and refused by `report` (H8).

Live evidence:
- [ ] Every live record: HTTP status, raw sanitized body, provider id if present, response `model` (pinned `typesafe/jev-1.13` or recorded as resolved/unknown), start/end timestamps, payload sha256, attempt count = 1 (H8).
- [ ] Durations plausible and non-constant; concurrency ≤ 4 consistent with timestamps.
- [ ] `smoke.json` is a real response and matches scored-record shape.
- [ ] No credentials anywhere in artifacts (grep for key-shaped strings and `Authorization`).

Metrics / claims:
- [ ] Independently recompute confusion matrices, per-class recall (counts), balanced accuracy, and Wilson intervals from raw JSONL (M10/M11).
- [ ] Accuracy reported over attempted *and* answered cases; failures listed with state sizes (M12).
- [ ] Latency only from single-question requests, n stated; share of calls above the 10 s production deadline (M13).
- [ ] No ranking metrics for top-1 Choice retrieval (L1). R1/R2 economics marked untested (M9).
- [ ] Confidence: no calibration claims; any threshold dev-tuned and holdout-tested once. E1 false approvals with high confidence listed (H9).
- [ ] Verdicts use protocol vocabulary, name the tested scope ("provider-level pilot, author-visible holdout, synthetic cases"), and match predeclared thresholds (H10, M14).

## Limitations of this review

- It covers the design only. No lane data, runner, or provider response existed to inspect.
- The reviewer's model identity is self-reported by its harness and can't be checked from inside the session.
- The blind relabel will be done by one model reviewer, so it's a second opinion, not ground truth.
