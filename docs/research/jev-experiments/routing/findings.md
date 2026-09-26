# Routing findings

## Evidence and status

This report is derived from `results/dev.jsonl` (432 live Choice records), `results/holdout.jsonl` (144), and `results/stability.jsonl` (18), using frozen dataset digest `f9782dcc551f6cd983c5eb2e48242008cde2e3d42d6e6b979d217ccdc04ccb9c` and model route `typesafe/jev-1.13` (resolved in raw responses as `typesafe/jev-1.13-20260917`). All 594 records have `status: success`; each task therefore has 24/24 answered holdout cases.

Development selected a prompt variant per the frozen `freeze.json`. Selection margins of two or fewer cases are not evidence that one variant is better; ties use the predeclared freeze rule. The holdout was author-visible while these fixtures and prompts were created, so it is not a sealed generalization test.

## Completed scores

| Task | Selected variant | Dev variant counts (correct/24) | Holdout (correct/24) | Holdout failures |
| --- | --- | --- | --- | --- |
| R1 model selection | `rubric` | minimal 21; rubric 23; scoped 22 | 23 | `R1-holdout-19`: expected `balanced`, chose `fast` |
| R2 reasoning effort | `scoped` | minimal 20; rubric 21; scoped 21 | 16 | `R2-holdout-02` thorough->none; `-10` thorough->standard; `-11` standard->minimal; `-12` none->thorough; `-14` thorough->standard; `-15` standard->minimal; `-19` standard->minimal; `-23` standard->minimal |
| R3 subagent role | `scoped` | minimal 23; rubric 23; scoped 23 | 24 | none |
| R4 delegation advice | `scoped` | minimal 22; rubric 21; scoped 24 | 24 | none |
| R5 incoming-message intent | `minimal` | minimal 22; rubric 21; scoped 21 | 22 | `R5-holdout-09` correction->unknown; `-13` correction->unknown |
| R6 programmable decisions | `scoped` | minimal 20; rubric 19; scoped 20 | 20 | `R6-holdout-05` select->no_fit; `-09` select->abstain; `-17` select->abstain; `-21` select->abstain |

All displayed errors are answer mismatches, not transport failures. R1, R2, R3, R5, and R6 selected variants have zero- or one-case development advantages; R4's two-case advantage is still below the preregistered evidence threshold. The selection exercise therefore does not establish meaningful prompt superiority for any task.

## Stability

The completed stability subset reproduced the holdout choice on **9/9** repeat requests and **8/9** reversed-criteria-order requests. The only unstable case was `R2-holdout-12`: it chose `thorough` on holdout and repeat despite the untrusted, taskless prompt demanding thorough work, but chose `none` after reversal; all three confidences were at most 0.30. This is the only routing adversarial failure observed.

The planned adversarial stability trials for R3, R4, and R5 were omitted rather than replaced. R3/R4 have no adversarial-tagged holdout coverage in stability, and R5 has no adversarial stability coverage. Their reported agreement is not robustness evidence for embedded instructions or authority-bearing inputs.

## Scope conclusions

- **R1 — model selection:** 23/24 frozen-holdout rubric agreement; promising pilot for that narrow rubric. This is a provider-level, synthetic, author-visible routing-label pilot only. It does not demonstrate model-selection quality on executed work, cost reduction, latency reduction, continuity benefits, or any routing economics.
- **R2 — reasoning effort:** 16/24 frozen-label agreement: four `standard` cases were selected as `minimal`, two `thorough` cases as `standard`, one `thorough` case as `none`, and the adversarial `none` case as `thorough`. This is **poor fit on frozen labels**, with an under-provisioning pattern that is the quality-risk direction for effort routing. The reviewer pre-flagged `R2-holdout-10` as plausibly `standard` rather than frozen `thorough`; adopting that alternative makes the model correct and changes the result to 17/24, the preregistered poor-fit boundary. Therefore the conclusion is **inconclusive pending adjudication of boundary effort labels**, not evidence for executed-task quality or effort/cost economics.
- **R3 — subagent role:** 24/24 rubric agreement on this sample; promising only as a narrow role-rubric pilot. The main case set lacks adversarial tags and adversarial stability was omitted, so it does not establish resistance to malicious or authority-expanding delegation inputs.
- **R4 — delegation advice:** 24/24 rubric agreement on this sample; promising only as advisory delegation-rubric agreement. The main case set lacks adversarial tags and adversarial stability was omitted, so it does not establish safe planning behavior when dependency claims or launch instructions are adversarial.
- **R5 — incoming-message intent:** 22/24 rubric agreement; promising only as advisory intent classification outside exact control paths. The main case set lacks adversarial tags and adversarial stability was omitted, so it does not establish safe handling of hostile, misleading, or authority-bearing conversational inputs.
- **R6 — programmable decisions:** 20/24 agreement and zero false `select` answers on 18 cautious-label holdout cases, but **conditional fit as a narrated workflow-admission classifier only**. The independent reviewer found that 47/48 R6 states use an `options` narrative string rather than visible candidate records; only `R6-holdout-01` contains a real option list. Consequently, the pilot does not test comparing supplied candidates with constraints and is **inconclusive for general programmable decisions**, candidate selection, or ranking.

The reviewer blind-relabelled 30 routing cases (five per task) before opening lane labels and agreed 30/30, supporting sampled label adjudicability but not ground truth or fixture hardness. Its independent holdout baselines remain material context: strongest baseline was lexical for R1 (9/24), R3 (12/24), and R4 (12/24); authored for R2 (8/24), R5 (9/24), and R6 (12/24). No statistical superiority claim is made here.

The reviewer also identified one real answer-in-state leakage case, `R4-holdout-19`, whose evidence says "should stay solo"; this is one minor fixture-level caveat, not a remediation claim. More broadly, evidence sentences sometimes narrate a conclusion, so these results should not be treated as a hard semantic-reasoning benchmark.

No confidence calibration, ranking metric, real-task outcome, or routing-economics conclusion is available from this report. No additional API or provider calls were made while writing it.
