# V6: final synthesis review

Run `jev-fit-20260919` · task V6 · worker `review` (Claude Code, `claude-opus-5`, self-reported) · 2026-09-19. No provider calls; no edits outside `review/final-synthesis-review.md` and `review/receipt-v6.json`.

**Audited** (sha256 prefixes; full digests in `receipt-v6.json`):

| Artifact | sha256 |
| --- | --- |
| `README.md` | `df0f12af…` |
| `integrated-results.json` | `c468ca13…` |
| `synthesis.json` | `6fdf7c31…` |
| `prompt-catalog.md` | `5086f3c1…` |
| `prompt-catalog.json` | `f7c2c8be…` |
| `build_report.py` | `ec63ea4f…` |
| `build_prompt_catalog.py` | `cc27fb57…` |

These are the **final versions after all corrections** (catalog augmentation, D3 fix, then C2–C5 and the omissions). The full numeric reproduction ran on the previous regeneration. On these final files I re-verified:
- the correction text;
- cross-artifact verdict consistency;
- catalog exactness (instructions vs freeze, all variants, failure lists vs scores);
- no drift in any holdout score or total.

**Checked against:**
- frozen `dataset.json` / `prompts.json` / `freeze.json` and raw `results/*.jsonl` for all four lanes, including the final D2–D6 dataset `11a6475a…d83`;
- `challenge/results/challenge.jsonl`;
- `interpretation-preregistered.md` (`e738473e…`, unchanged from the preregistration record).

**Tools:**
- The unchanged `review/audit.py` (`8be6f9c9…`), `score --freeze` per lane and phase.
- Short read-only inline recomputations for totals, prompt exactness and shortcuts.
- The p6 blind labels `review/labels-discovery-extra-v2.json` (`8aad1329…`), read-only. p6's `discovery-extra-v2-assessment.md` and `receipt-v5.json` **weren't present** at review time; nothing from them is assumed.

## Verdict

**FINAL: no unresolved material synthesis findings.** C1–C5 and all four omissions are resolved in the current files. V5 is reconciled below; C6 and C7 are closed as non-material. Report files are unchanged since the last pin (README `df0f12af…`, synthesis `6fdf7c31…`, integrated-results `c468ca13…`, catalog `f7c2c8be…`/`5086f3c1…`).

**Earlier status line (kept for the record):** all corrections C1–C5 and all four omissions are resolved in the current files. The report is numerically accurate, the prompt export is exact, and the verdicts are consistent with the preregistration as qualified.

**p6 (V5) assessment now present** (`discovery-extra-v2-assessment.md`, sha `26407b7a…96ab3`; `receipt-v5.json` still absent), so the README link now resolves. I read it once. Its numbers and case analysis agree with mine:
- 22/25 blind agreement;
- the same three duplicate-content errors in D4/D6;
- the D3-holdout-11 answerability dispute;
- D6 longest-section 14/24;
- D2–D6 stability 10/10 on both repeat and reversed;
- 500/500 attributable records.

Two small new corrections follow from it (C6, C7 below). Both are **open**.

The overall conclusion is unchanged: bounded advisory classification is supported, and no authority-bearing use is.

### Resolution log (verified in final files)

| Item | Resolution in current `synthesis.json` / README |
| --- | --- |
| C1 D3 | "Inconclusive answerability boundary": relevance-versus-answerability dispute; no-superiority p=0.25 retained. **Resolved.** |
| C2 D4/D6 | Both now state duplicate-content alternatives affect model *and* baseline correctness, so the paired p isn't interpretable until adjudicated. **Resolved.** |
| C3 E6 | Now "a material-change event … suppressed at confidence 0.37; it was not an explicitly requested notification", with the dev all-variant suppression. The limit is framed as a coordinator qualification. **Resolved.** |
| C4 R2 | Now "Poor fit in this setting" via the preregistered repeated-semantic-failure clause; the 16→17 label sensitivity is preserved. **Resolved.** |
| C5 E2 | "Clean 24/24 within the evidence lane"; "strongest" removed. The Bonferroni sensitivity (0.05/20) retains D2, D5, R1, R3–R5, not E1/E2, and is stated as not replacing the preregistered rules. **Resolved.** |
| Omission: stability | 33/35 repeat, 32/35 reversed, with the per-lane split. Matches my recomputation. **Resolved.** |
| Omission: p6 blind | 22/25 (5/5, 4/5, 4/5, 5/5, 4/5), with all three disagreements matching Jev's alternative. Matches. **Resolved.** |
| Omission: E6 dev | Included in the E6 condition. **Resolved.** |
| Omission: D6-holdout-13 flag | Explained: no rationale field sent, and the overlap doesn't identify gold. **Resolved.** |

Verdict strings are identical across the README table, `synthesis.json`, `integrated-results.json` and the catalog (20/20). Catalog: instructions equal the freeze and the example bodies, all variants equal `prompts.json`, and `observed_holdout_failures` count = 24 − `correct_out_of_24`, which equals the integrated holdout for all 20. No holdout score or total changed (2070 records, 2 failures, $0.051674868).

### V5 reconciliation (final)

V5 = `review/discovery-extra-v2-assessment.md`, **final sha `43bd0257…726e84e`** (refreshed from `26407b7a…` after the latency-wording correction), with `review/receipt-v5.json`, **final sha `750724d5…3eb3d0`**. Its recorded artifact hash matches the current assessment.

- **Agreement:** V5's inputs, audit tool hash, blind agreement (22/25), holdout scores, paired statistics, stability (10/10, 10/10), shortcut figures and error analysis all agree with my independent results. No numeric conflict.
- **Verdicts:** V5 rates D3/D4/D6 *conditional fit*; the synthesis reports *inconclusive*. Root's stated reason is that ambiguous labels affect the baseline comparisons too. That's the C2 argument, already written into the D4/D6 conditions, with D3 framed as a material answerability dispute. That reasoning is explicit, fits the preregistration's "material unresolved label defects" clause, and is the more cautious reading. The README links V5, so readers can see the reviewer's rating.
- **C6 (disclosure) → closed, non-material.** An explicit "V5 rated conditional" sentence would be nice to have but isn't required. No reader is misled about the evidence.
- **C7 (D6-holdout-13) → closed, non-material.** V5 calls it "material" fixture leakage; the README calls it a non-identifying overlap. Both agree no rationale field was sent. The competing section restates the gold diagnosis, which makes it a duplicate-content instance already covered by the D6 condition. Jev answered it correctly, so no score is affected.
- **V5 latency wording: corrected in final V5.** Line 98 now reads "Development also used one Choice per request". The earlier V5 text said "Batched development latency is not compared…", which was wrong for this run: **all 2070 requests (1440 dev, 480 holdout, 70 stability, 80 challenge) carry exactly one Choice question**, which I verified from the logged request bodies. The phrase comes from a generic note printed by my own `review/audit.py` latency summary ("batched dev requests are not comparable…"), which assumed a batching design this run didn't use. The README already states "All variants used one question per request". **No synthesis impact.** `audit.py` is deliberately left unchanged; its generic batched-latency note is inapplicable to these one-question requests.

### Earlier interim note on V5 (superseded by the reconciliation above)

**C6 (open, disclosure): reviewer-vs-root verdict difference for D3/D4/D6.** V5 rates D3, D4 and D6 **Conditional fit**; root publishes **Inconclusive** for all three.
- Root's more conservative choice is defensible, and I endorse it for D4/D6: C2 makes the baseline p-values uninterpretable. For D3 either reading fits the preregistration.
- For E6 the README explicitly says the coordinator downgraded the reviewer's label. **Add the same disclosure for D3/D4/D6**, e.g. "Independent V5 review rated conditional fit; coordinator reports inconclusive because duplicate-answer/answerability disputes are unresolved."

**C7 (open, wording): D6-holdout-13.** The README says the overlap "does not identify the gold option". That's true, and I agree it isn't a transmitted rationale field. V5 is also right, though: the competing section `sec_id` ("…from/cursor mix is the error.") restates the gold diagnosis, which makes this another duplicate-content case, not a clean independent test.
- **Append:** "the competing section restates the diagnosis, so this case shares the duplicate-content limitation (V5)."
- Jev answered it correctly (`sec_cursor_mix`, conf 0.87), so no score changes.

*The sections below are the original review findings, kept for the record.*

## 1. Numerical accuracy: pass

Independently recomputed from raw logs. **All 20 tasks match `integrated-results.json` and the README table exactly** on:
- dev correct per variant;
- selected variant (it reproduces the tie rule);
- holdout correct/attempted;
- the strongest baseline, including E4's tie of authored = lexical = 7 with p 0.02148 and 0.07681;
- paired exact McNemar p.

| Claim | Recomputed |
| --- | --- |
| Records by phase | dev 1440, holdout 480, stability 70, challenge 80 = **2070**; **2** failures (HTTP 502, E1 minimal dev) |
| Resolved model | `typesafe/jev-1.13-20260917` on all 2068 successes |
| Provider cost | $0.05167487 (provider-reported) |
| Holdout latency | n=480, p50 563.6 ms, p95 718.4 ms, max 1505.9 ms, 0 > 10 s |
| Challenge | 79/80 |
| Freeze discipline | all lanes: dataset digest = freeze; 0 dev records after freeze; 0 holdout records before freeze; 0 unattributable/duplicate/unknown records |
| E4 "five of six expected-complete rejected" | 5/6 ✓ |
| D1 "answer first in 17/24", "1/3 abstained" | ✓ |
| D6 post-hoc longest-section 14/24 | ✓ (final dataset) |
| D2–D6 first-option shortcut, final dataset | 2/5/6/6 of 24 for D2/D4/D5/D6 on criteria order, and 2 for D3: the v1 position channel is gone ✓ |

**One audit flag, explained, not an error:** `audit.py` reports "rationale text present in payload" for `DX-D6-holdout-13`. The rationale ("from/cursor mix is the error.") is a substring of the distractor section `sec_id`, not of the gold option. It's a coincidental overlap that points *away* from the answer, so there's no leakage. The README's "rationales … excluded from model inputs" stays accurate.

## 2. Prompt catalog exactness: pass

- **Selected instructions:** for all 20 tasks, `prompt-catalog.json` `instructions` is byte-identical to `freeze.selected_instructions`, to the instructions in every logged holdout request body, and to the text in `prompt-catalog.md`.
- **Variants:** all 60 `all_variants` entries equal `prompts.json`. Catalog `dataset_sha256`/`prompts_sha256` match the frozen files.
- **Example bodies:** every `example_request` is exactly `{model, state, questions}` and reproduces a real **dev** case (state and criteria in the same order). No holdout content is exported.
- **Catalog augmentation (final version):** for all 20 tasks, `observed_holdout_failures` (id/expected/selected/status) equals the set of holdout mismatches recomputed from the raw logs. `correct_out_of_24` equals the recomputed holdout score, and `interpretation` equals `synthesis.json`. The selected instructions, variants and examples are unchanged.
- **Cross-artifact consistency:** the verdict string for each of the 20 tasks is identical across the README table, `synthesis.json`, `integrated-results.json` and the catalog.

## 3. Verdict consistency with preregistration

| Task | Report | Assessment |
| --- | --- | --- |
| D1 | Conditional; position-confounded | ✓ Consistent (≥20, p=0.125 vs lexical; post-hoc 5–1 vs position-only). |
| D2 | Promising advisory | ✓ 24/24 vs 10, p=0.00012. p6 blind 5/5. No position channel (first-option 2/24). Stability 2/2 stable. |
| D3 | Inconclusive answerability boundary (revised; resolved) | ✓ **C1 resolved.** Under the preregistration both "conditional" (≥20, p=0.25) and "inconclusive" (unresolved label dispute) are defensible. Inconclusive is the more cautious reading, so it's endorsed. |
| D4 | Inconclusive top-1 labels | ✓ Endorsed; C2 reason now included (**resolved**). |
| D5 | Promising advisory | ✓ 24/24 vs 14, p=0.00195; p6 5/5; first-option 6/24. |
| D6 | Inconclusive | ✓ Endorsed; C2 reason now included (**resolved**). |
| R1, R3, R4, R5 | Promising (rubric/advisory) | ✓ |
| R2 | Poor fit in this setting (final) | ✓ Matches recommendation C4 (**resolved**). |
| R6 | Inconclusive for general use | ✓ Consistent with narrated options (47/48). |
| E1 | Promising shadow pilot | ✓ |
| E2 | Promising advisory | ✓ Wording softened; Bonferroni sensitivity added (**resolved**). |
| E3, E4 | Inconclusive | ✓ Contested labels / state contract. |
| E5, E7 | Conditional; no added value | ✓ |
| E6 | Conditional (coordinator downgrade) | ✓ Reason corrected per C3 (**resolved**). |
| E8 | Conditional; human adjudication | ✓ |

## 4. Concrete corrections

**C1 (D3 wording): RESOLVED in the final files.** README, `synthesis.json`, `integrated-results.json` and the catalog now describe holdout-11 as a relevance-versus-answerability dispute (Jev and the blind reviewer both chose `mem_price`; gold `none`). No "stale/current-price" wording remains anywhere. Original finding kept below for the record.

*Original finding:* README and `synthesis.json` D3 say: "A current-price query selected a stale pricing memory instead of none."
- The only D3 error is `DX-D3-holdout-11`. The query is "How do we bill batched Jev questions on OpenRouter alpha?". `mem_price` reads "…$0.042 per million tokens… OpenRouter alpha batch billing is **not established by that number**."
- The memory isn't stale, and it arguably answers the question in the negative. p6's blind label is `mem_price`, the same as Jev.
- **Replace with:** "The single error (holdout-11) is a disputed label: the blind reviewer and Jev both chose a memory that states batch billing is not established; frozen label `none`. If adjudicated, 24/24 vs 20/24 is still 4–0, p=0.125, so no superiority either way."
- The verdict is unchanged.

**C2 (D4/D6 rationale, under-stated).** The report explains "inconclusive" by the Jev/reviewer alternative on one case. The duplicate-answer defect is broader, and it affects the *baseline comparison*, not just Jev's score:
- Every D4 error (holdout-02, -23) and every D6 error (holdout-15, -20, -21) has a distractor that restates the gold content. For example, D4-02's `sess_e2e` names `run-code/scripted-e2e.test.ts` outright. D6-20's `sec_preview` contains the same scripted-bound failure. D6-21's `sec_heartbeat` says "cancel_shell_monitor does not kill the job" with the same pid.
- p6 agrees with Jev's alternative on D4-23 and D6-15.
- Because baselines are also scored against single gold labels, baseline "errors" on duplicate-content cases may be correct under adjudication. So **the reported p-values (0.00391, 0.00098) may overstate superiority**, and Jev's 22/24 and 21/24 may understate accuracy.
- **Add:** "Duplicate-content distractors make top-1 labels non-unique for both Jev and baselines; paired p-values are not interpretable until duplicate answers are adjudicated." This is the stronger justification for the conservative label.

**C3 (E6 downgrade reason, overstated).** The README says the downgrade is "because required notification intent was missed."
- The suppressed case `E6-holdout-023` ("experiment exhausted its planned cases earlier than expected…") is labelled `NOTIFY_MATERIAL_CHANGE`. It has **no explicit requested-notification intent**, and no mandatory failure notice was suppressed anywhere.
- The downgrade itself is reasonable on substance, and I'd keep it. Suppression is the task's costly direction, and it recurred in dev: `E6-dev-020`, a blank completion record expected `NOTIFICATION_UNKNOWN`, was suppressed by **all three** variants.
- **Replace with:** "A material-change event (not an explicitly requested milestone) was suppressed at confidence 0.37, and dev showed the same suppression direction under all variants; since suppression is the task's costly error, fit is limited to advisory ranking, not suppression." Also label it as a coordinator qualification beyond the numeric thresholds, as the E6 section already implies.

**C4 (R2 verdict, reasoning).** The preregistration defines poor fit as "fewer than 17/24 correct with resolved labels, **or repeated failure of the task's essential semantic distinction**".
- The label dispute moves R2 across the 17/24 line, so the first trigger is contested.
- The second trigger holds regardless: **four undisputed standard→minimal errors** (conf 0.55–0.88) plus two thorough→standard. That's 6/8 errors in the under-effort direction, and an injected effort demand was followed on holdout and repeat.
- **Recommend:** "Poor fit in tested setting (repeated under-effort; score label-sensitive at 16–17/24)".
- If root keeps "Inconclusive", the README should state why the repeated-failure clause doesn't apply. Otherwise it reads as a threshold-only judgment. As written, R2 is the least cautious verdict in the report relative to its own rules.

**C5 (E2 "strongest completed evidence classification").** E2 is 24/24, but its paired p (0.00391) is weaker than D2, R1, R3, R4, R5 and D5. It has no adversarial holdout or adversarial stability trial, and its states are one sentence. Under the report's own caveat of 20 unadjusted tests, a Bonferroni screen (α≈0.0025) would retain D2, D5, R1, R3, R4, R5 but **not E1 (0.00635) or E2 (0.00391)**.
- **Replace** "Strongest completed evidence classification" **with** "Clean 24/24 within the evidence lane; untested against adversarial failures."
- I'd also add one sentence noting which promising tasks survive a multiplicity adjustment. The README already says the p-values are unadjusted, so this is disclosure, not a verdict change.

## 5. Omissions (add, low effort)

1. **Stability summary numbers.** The README describes the stability design but not results. Recomputed agreement with the holdout answer:

   | Lane | Repeat | Reversed | Flips |
   | --- | --- | --- | --- |
   | Evidence | 12/14 | 12/14 | E4-001 on reversal; E8-010, E8-024 |
   | Routing | 9/9 | 8/9 | R2-012 injection case |
   | D1 | 2/2 | 2/2 | — |
   | D2–D6 | 10/10 | 10/10 | — |
   | **Overall** | **33/35** | **32/35** | every flip at conf ≤ 0.52 |

   Add one line.
2. **D2–D6 v2 blind agreement:** p6 22/25 (D2 5/5, D3 4/5, D4 4/5, D5 5/5, D6 4/5). In all three disagreements p6 chose the same alternative Jev did. Cite this until p6's assessment lands.
3. **The E6 dev repeat of the suppression direction** (C3) isn't in the report.
4. **D6-holdout-13 audit flag:** mention it's a coincidental distractor overlap if the audit JSON is linked, so readers don't take it for leakage.

## 6. Things verified as correctly disclosed (no change)

- Author-visible holdout.
- Choice top-1 only.
- R1/R2 economics untested.
- R6 narrated options.
- E5/E7 fixture channels.
- D1 position bias.
- The v1 D2–D6 rejection before calls.
- The challenge reported separately and not pooled, with authorship non-independence noted.
- Unadjusted p-values.
- Wilson bound at 24/24.
- Cost not billing-verified.
- 60 s runner vs 10 s production deadline.
- Reversal changed criteria order only.
- Omitted adversarial stability trials (E2/E6/R3/R4/R5).
- The unmeasured list (calibration, long context, multilingual, Score/Noul, production replay, routed-task outcomes).

## Limits of this review

- One model reviewer.
- No provider calls, so provider IDs are not cross-checked with OpenRouter.
- p6's written assessment was absent; only p6's label file was used.
- C2's baseline-side effect is argued from inspected cases, not an adjudicated count.
