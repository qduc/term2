# Jev in term2: live task-fit experiments

Completed research pilot, 2026-09-19. No production behavior or settings were changed. The strongest evidence supports bounded advisory classification, including tool and code-passage selection, specialist selection, delegation advice, incoming-message intent and failure triage. Retrieval results need the task-specific qualifications below. Automatic approval, stopping, completion certification and output suppression are not supported by this experiment.

Read the [exact tested prompts](prompt-catalog.md), [complete request examples and all variants](prompt-catalog.json), [machine-readable results](integrated-results.json), and [source-based opportunity inventory](../jev-decision-model-opportunities.md).

## What was tested

20 task families, each with 24 development and 24 author-visible holdout cases: 960 main synthetic fixtures. Three prompt variants per task produced 1440 development requests; frozen selections produced 480 holdout requests. There were 70 separate repeat/order requests and an 80-case challenge probe. Total: **2070 live requests, 2068 successful responses**, excluding the one successful smoke request. Failures count as wrong; no retries replaced them.

Subject: `typesafe/jev-1.13`, requested through term2's existing OpenRouter decision endpoint; successful responses resolved to `typesafe/jev-1.13-20260917`. The user's zai preference was applied to the GLM authoring worker. GLM, Codex, Claude and Grok authored or reviewed experiments; this is not a comparative benchmark of those workers as decision models. Grok used its default harness model without an override.

Only **Choice top-1** was measured. Memory/session/code selection here does not establish full ranking, candidate-generation recall, or end-to-end retrieval quality. R1/R2 measure rubric agreement, not actual routed task quality or savings. R6 was narrowed to workflow-admission classification; generic programmable decisions remain unestablished.

## Results by task

All scores are out of 24. Development columns are minimal/rubric/scoped. Baseline is the strongest of the independently reproduced authored heuristic, independent lexical probe and dev-majority predictor. Exact two-sided paired McNemar p-values are exploratory and unadjusted across 20 tasks; they are screening evidence, not confirmatory population claims. If strongest baselines tie, all their p-values are shown. Full win/loss counts, class recall and Wilson intervals are retained in the audit JSON files.

| Task | Dev m/r/s | Selected | Holdout | Best baseline | Paired p | Fit in this pilot |
| --- | --- | --- | --- | --- | --- | --- |
| D1 Skill selection | 22/23/23 | scoped | 21/24 | 16/24 | 0.125 | Conditional; position-confounded |
| D2 Tool/MCP discovery | 19/24/23 | rubric | 24/24 | 10/24 | 0.00012 | Promising advisory pilot |
| D3 Memory retrieval | 24/24/24 | scoped | 23/24 | 20/24 | 0.25 | Inconclusive answerability boundary |
| D4 Prior-session retrieval | 24/24/24 | scoped | 22/24 | 13/24 | 0.00391 | Inconclusive top-1 labels |
| D5 Code/search selection | 24/24/24 | scoped | 24/24 | 14/24 | 0.00195 | Promising advisory pilot |
| D6 Output-section selection | 24/24/24 | scoped | 21/24 | 8/24 | 0.00098 | Inconclusive diagnostic priority |
| R1 Model-tier classification | 21/23/22 | rubric | 23/24 | 9/24 | 0.00012 | Promising rubric pilot |
| R2 Reasoning effort | 20/21/21 | scoped | 16/24 | 8/24 | 0.07681 | Poor fit in this setting |
| R3 Specialist role | 23/23/23 | scoped | 24/24 | 12/24 | 0.00049 | Promising advisory pilot |
| R4 Delegation plan | 22/21/24 | scoped | 24/24 | 12/24 | 0.00049 | Promising advisory pilot |
| R5 Incoming-message intent | 22/21/21 | minimal | 22/24 | 9/24 | 0.00024 | Promising advisory pilot |
| R6 Programmable decisions | 20/19/20 | scoped | 20/24 | 12/24 | 0.07681 | Inconclusive for general use |
| E1 Approval risk/authorization | 19/21/21 | scoped | 21/24 | 11/24 | 0.00635 | Promising shadow pilot |
| E2 Failure triage | 24/24/24 | scoped | 24/24 | 15/24 | 0.00391 | Promising advisory pilot |
| E3 Semantic progress | 22/22/23 | scoped | 19/24 | 7/24 | 0.00183 | Inconclusive |
| E4 Completion evidence | 16/14/15 | minimal | 15/24 | 7/24 | 0.02148, 0.07681 | Inconclusive |
| E5 Compaction salience | 23/24/23 | rubric | 24/24 | 24/24 | 1 | Conditional; no added value shown |
| E6 Notification importance | 23/23/22 | rubric | 21/24 | 11/24 | 0.00635 | Conditional advisory fit |
| E7 Supplemental test targeting | 24/24/24 | scoped | 23/24 | 22/24 | 1 | Conditional; no added value shown |
| E8 Offline evaluation triage | 22/21/21 | minimal | 20/24 | 11/24 | 0.01172 | Conditional; human adjudication |

The preregistered promising-pilot threshold was at least 20/24 plus paired improvement over the strongest baseline, without a material label dispute or required-invariant failure. Conditional means narrower use or no demonstrated superiority. Inconclusive includes unresolved fixture/label defects. The [preregistration](interpretation-preregistered.md) remains unchanged; coordinator qualifications appear explicitly in each task's interpretation.

As an exploratory multiplicity sensitivity check, a Bonferroni cutoff of 0.05/20 retains the paired improvements for promising tasks D2, D5, R1, R3, R4 and R5; E1 and E2 do not pass that stricter screen. This does not replace the preregistered pilot rules. A perfect 24/24 still has a Wilson 95% lower bound of about 86%. These small synthetic samples cannot establish production reliability.

## Prompting and state contracts

Use the exact instructions together with their criteria and state shape in the catalog. Prompt prose alone is not the experiment. A development winner separated by zero, one or two cases is weak evidence of superiority; ties used scoped > rubric > minimal. Losing variants were not run on holdout, so the holdout cannot establish which variant is best.

### D1: Skill selection

**Conditional; position-confounded.** No superiority over lexical baseline; expected answer first in 17/24 holdouts. Only 1/3 insufficient-evidence cases abstained; no holdout no-fit labels.

Send the primary deliverable and full candidate capabilities. Separate no matching capability from insufficient context. The selected scoped wording did not establish reliable abstention.

Tested instructions: [D1, scoped](prompt-catalog.md#d1-scoped); frozen criteria and states: [discovery/dataset.json](discovery/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### D2: Tool/MCP discovery

**Promising advisory pilot.** 24/24 versus 10/24 authored baseline, p=0.00012. Synthetic 16-tool catalog, not exact installed-tool discovery; does not authorize or execute a tool.

Supply tool descriptions and eligibility explicitly; select none when required capability is absent or ineligible. Distinguish transcript search, persistent-memory search, local files and web sources.

Tested instructions: [D2, rubric](prompt-catalog.md#d2-rubric); frozen criteria and states: [discovery-extra/dataset.json](discovery-extra/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### D3: Memory retrieval

**Inconclusive answerability boundary.** 23/24 versus 20/24 baseline, p=0.25. Jev and the blind reviewer chose a relevant pricing memory that explicitly says OpenRouter batch billing is unestablished; gold requires none because it does not answer how billing works. This is a relevance-versus-answerability label dispute, not evidence of stale-memory behavior. No retrieval recall or full-ranking result.

Supply the current question and actual memory content with stable IDs. Require an answer to the question, not topical overlap; permit none for stale or irrelevant memories.

Tested instructions: [D3, scoped](prompt-catalog.md#d3-scoped); frozen criteria and states: [discovery-extra/dataset.json](discovery-extra/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### D4: Prior-session retrieval

**Inconclusive top-1 labels.** 22/24 versus 13/24 baseline, but expanded excerpts created duplicate-answer cases. A blind reviewer and Jev both prefer a defensible alternative on holdout-23. This supports relevant-excerpt suggestions, not a reliable unique winner or end-to-end search result. Duplicate-content alternatives make top-1 labels non-unique for both Jev and baselines; the paired comparison needs adjudication before interpretation.

Supply excerpts and provenance, and name the decision or conversation being sought. Match the historical decision rather than a shared topic word; preserve provenance in the returned selection.

Tested instructions: [D4, scoped](prompt-catalog.md#d4-scoped); frozen criteria and states: [discovery-extra/dataset.json](discovery-extra/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### D5: Code/search selection

**Promising advisory pilot.** 24/24 versus 14/24 baseline, p=0.00195. Chooses among short synthetic code passages with named symbols; no real-repository retrieval recall, full ranking or implementation correctness result.

Supply the requested symbol or behavior plus paths and actual code. Distinguish definition, caller and adjacent implementation; passage instructions remain data.

Tested instructions: [D5, scoped](prompt-catalog.md#d5-scoped); frozen criteria and states: [discovery-extra/dataset.json](discovery-extra/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### D6: Output-section selection

**Inconclusive diagnostic priority.** 21/24 versus 8/24 preregistered baseline, but several observed-symptom versus cause/action choices are defensible. Post-hoc longest-section heuristic reaches 14/24. Presentation advice only; raw output and required evidence must remain available. Duplicate-content alternatives affect both model and baseline correctness, so the paired p-value is not reliable evidence of superiority until adjudicated.

State the diagnostic goal and provide complete candidate sections. Select actionable evidence, including denials and truncation, over reassuring boilerplate; none means no diagnostic evidence.

Tested instructions: [D6, scoped](prompt-catalog.md#d6-scoped); frozen criteria and states: [discovery-extra/dataset.json](discovery-extra/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R1: Model-tier classification

**Promising rubric pilot.** Abstract fast/balanced/deep agreement only. No model execution, savings, cache economics or task-quality comparison.

Supply eligibility, requested work and uncertainty. Define mechanical edits separately from engineering judgment. Preserve the current route with none when evidence is insufficient.

Tested instructions: [R1, rubric](prompt-catalog.md#r1-rubric); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R2: Reasoning effort

**Poor fit in this setting.** Original score 16/24 is sensitive to one disputed label (17/24 if changed), but repeated under-effort remains: four standard-to-minimal and two thorough-to-standard errors, plus an injected demand followed on holdout and repeat. The preregistered repeated-semantic-failure clause supports poor fit despite the score-boundary dispute.

Provide actual uncertainty and subsystem interactions. Current minimal/standard/thorough boundaries need adjudication; no tested wording justifies lowering effort automatically.

Tested instructions: [R2, scoped](prompt-catalog.md#r2-scoped); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R3: Specialist role

**Promising advisory pilot.** Explorer/worker/reviewer/none classification; no downstream worker outcomes. No adversarial-tagged main holdout.

Include eligible roles, authority, requested deliverable and acceptance condition. Select none for ineligible or underspecified work; a role label does not authorize spawning.

Tested instructions: [R3, scoped](prompt-catalog.md#r3-scoped); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R4: Delegation plan

**Promising advisory pilot.** Parallel/serial/solo/defer rubric agreement. One holdout explicitly says solo; dependencies are largely narrated, not inferred from a real work graph.

Provide dependencies, independence, clarity and coordination cost. Require a real dependency for serial work and independent units for parallel work. Keep launch authorization separate.

Tested instructions: [R4, scoped](prompt-catalog.md#r4-scoped); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R5: Incoming-message intent

**Promising advisory pilot.** Presentation classification only; exact approval and control routing stays deterministic. Two corrections were classified unknown.

Provide the prior objective and incoming message together. Use unknown for missing context or exact control paths. The minimal variant won narrowly, not conclusively.

Tested instructions: [R5, minimal](prompt-catalog.md#r5-minimal); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### R6: Programmable decisions

**Inconclusive for general use.** 20/24 only on narrated workflow admission. In 47/48 fixtures options are narrative strings; this does not test arbitrary bounded decisions, option checking, tool exposure or Score/Noul.

For a successor trial, provide inspectable options and explicit constraints. Separate select, abstain, no-fit and rejected disclosure. These improvements are recommendations, not a validated general prompt.

Tested instructions: [R6, scoped](prompt-catalog.md#r6-scoped); frozen criteria and states: [routing/dataset.json](routing/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E1: Approval risk/authorization

**Promising shadow pilot.** Risk and authorization scored separately, not a joint approval rate. No false permissive answers in the small cautious subset; this is insufficient for approval authority.

Ask separate risk and authorization questions. Supply exact effect, target, user intent and standing authority; do not infer authorization from low risk or model confidence.

Tested instructions: [E1, scoped](prompt-catalog.md#e1-scoped); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E2: Failure triage

**Promising advisory pilot.** Clean 24/24 within the evidence lane. Main holdout lacks adversarial cases; typed recovery and replay safety remain deterministic.

Supply observed typed failure and relevant diagnostic evidence. Distinguish transport, credentials, schema, policy and implementation failures; use unknown when evidence is absent.

Tested instructions: [E2, scoped](prompt-catalog.md#e2-scoped); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E3: Semantic progress

**Inconclusive.** 19/24 and a disputed fixed-seed rerun label. No support for stopping or killing a run.

Supply the objective and before/after evidence. Separate new evidence from repeated activity. Explicitly represent what a rerun was intended to establish.

Tested instructions: [E3, scoped](prompt-catalog.md#e3-scoped); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E4: Completion evidence

**Inconclusive.** 15/24, but fixtures often omit requirements while labelling fragments complete. Five of six expected-complete cases were rejected; this cannot isolate model quality.

Provide explicit requirements and evidence per requirement. A bare tests-passed fragment is not enough. Fix the state contract before tuning prose; no tested prompt establishes completion authority.

Tested instructions: [E4, minimal](prompt-catalog.md#e4-minimal); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E5: Compaction salience

**Conditional; no added value shown.** 24/24 ties a deterministic prefix heuristic on labelled candidates. Does not test real compaction or information preservation.

Supply candidate constraints, unresolved work and decisions. A preservation checklist may assist the summarizer; do not replace history, tool pairing or deterministic retention rules.

Tested instructions: [E5, rubric](prompt-catalog.md#e5-rubric); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E6: Notification importance

**Conditional advisory fit.** 21/24, but a material-change event was suppressed at confidence 0.37; it was not an explicitly requested notification. Dev also suppressed an unknown completion event under all three variants. Coordinator limits fit to advisory ranking because suppression is the costly error, beyond the numeric threshold.

Supply notification intent, previous state and actual change. Distinguish requested milestones from generic progress; preserve required failure/action/completion notices outside model suppression.

Tested instructions: [E6, rubric](prompt-catalog.md#e6-rubric); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E7: Supplemental test targeting

**Conditional; no added value shown.** 23/24 versus a 22/24 changed-surface heuristic; fixture already labels the relevant subsystem.

Provide changed behavior and explicit required gates. Suggest additional targeted tests only; never use a decision answer to waive repository checks.

Tested instructions: [E7, scoped](prompt-catalog.md#e7-scoped); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

### E8: Offline evaluation triage

**Conditional; human adjudication.** 20/24, unstable repeats and an embedded-instruction failure. Useful for suggestions, not gold-label generation.

Supply the case, rubric and observed outputs as evidence. Separate prompt omission, label ambiguity, state overload, position sensitivity, transport/schema failure and other task error. Keep annotator claims untrusted and independently adjudicate.

Tested instructions: [E8, minimal](prompt-catalog.md#e8-minimal); frozen criteria and states: [evidence/dataset.json](evidence/dataset.json). Any suggested state or criterion repair above is follow-up advice, not a newly tested prompt.

## Reliability, latency and cost

Main holdout requests: p50 **564 ms**, p95 **718 ms**, maximum 1506 ms; 0/480 exceeded the production adapter's ten-second deadline. These are provider-request timings, not end-to-end agent latency. The experimental runner allowed 60 seconds, so its behavior differs from the production adapter.

Provider-returned `usage.cost` sums to **$0.05167487** over 2068 responses across development, holdout, stability and challenge. This excludes worker-harness spending and the smoke request ($0.000014574), and is not billing-verified. The two original development failures were HTTP 502 for E1 minimal after roughly 41–43 seconds; prompt comparisons on that task are partly confounded by transport failure. All variants used one question per request; generic audit notes about batched development latency do not describe this run.

Stability trials are separate from headline accuracy and preserve failures. Ordinary and adversarial cases were selected in file order. Missing adversarial cases for E2/E6/R3/R4/R5 were omitted under recorded pre-call amendments, rather than using the original first-two-case fallback. Reversal changed criteria order only, not candidate order inside state. This sparse probe cannot establish order invariance or isolate stochastic variation from order effects. Across 35 sampled cases, repeat answers agreed with the original holdout in 33/35 and reversed-order answers in 32/35. Evidence: 12/14 and 12/14; routing: 9/9 and 8/9; D1: 2/2 and 2/2; D2–D6: 10/10 and 10/10. See each lane's stability-plan.json and aggregate results.

The independent 80-case challenge scored **79/80** with its own scoped prompt. E8 confused a label-noise case with model disagreement after an injected annotator claim. This is a separate four-case-per-task probe, not transfer of the main selected prompts and not pooled with their holdouts. Grok later authored D2–D6, so challenge authorship is not independent of that lane; the challenge was already frozen and was not reused as its cases.

## Evidence quality and deviations

- Inputs and selected prompts were hashed and frozen before holdout calls; raw logs retain request bodies, body hashes, response IDs, resolved model, usage and timing. Labels, rationales, split names and baseline answers were excluded from model inputs. Independent scoring recomputes outcomes from those logs.
- Holdouts were visible to the authors who wrote the prompts. Independent reviewers labelled five sampled holdout cases per task before viewing lane labels/results. This reduces obvious label errors; it does not create sealed or human-adjudicated ground truth. Label disagreements and uncertainties remain visible, with original scores preserved. The fresh D2–D6 blind sample agrees with gold in 22/25 (5/5, 4/5, 4/5, 5/5, 4/5 respectively); in all three disagreements the reviewer chose the same alternative as Jev.
- D1 retains material answer-position bias. D3–D6 initially had short distractors and answer-first ordering; that version was rejected before provider calls. Final revisions and the [fresh blind audit](review/discovery-extra-v2-assessment.md) are documented with the retained dataset-v1-rejected.json. D6-holdout-13 has a rationale-substring audit flag in a competing section: no rationale field was sent, and the overlap does not identify the gold option. Post-hoc first-option/longest-text diagnostics are in aggregate/shortcuts.json and are not preregistered baselines.
- E3/E4 and R2 have material label or state-contract problems. E5's preservation prefixes and E7's labelled change surfaces give simple heuristics most or all of the answer. High scores there do not establish added model value. R6 retained narrated options in 47/48 fixtures.
- The challenge is too small for the main audit's 24/24 contract; those contract warnings are intentional and remain visible. It is reported separately.
- No calibrated confidence threshold, long-context sweep, multilingual evaluation, provider-independent comparison, Score/Noul trial, production replay, or routed-task cost/quality result was established. These remain unmeasured possibilities, not successful uses.

## Practical next steps

1. Pilot failure triage and role/delegation/intent suggestions in shadow or advisory mode, preserving typed error handling, exact controls and user authority.
2. Validate discovery on real candidate pools with balanced positions, substantial competing content, no-match cases and labelled relevance; measure whether suggestions actually reduce wrong loads or search work.
3. Fix explicit requirements/evidence contracts before more completion or progress prompting. Compare compaction and test suggestions against the already-strong deterministic heuristics.
4. For model/effort routing, run fixed-versus-routed complete tasks and count quality, retries, wall time, cache effects and total cost. Classification agreement cannot answer those questions.
5. Evaluate Score, Noul, multi-question batching and genuinely agent-authored bounded decisions separately. Retain policy in each domain owner rather than granting one generic classifier authority.

## Reproduction and artifact map

Offline only; these commands do not invoke a provider:

```sh
python3 docs/research/jev-experiments/infra/runner.py selftest
python3 docs/research/jev-experiments/review/audit.py --selftest
python3 docs/research/jev-experiments/infra/aggregate.py
python3 docs/research/jev-experiments/infra/shortcut_audit.py
python3 docs/research/jev-experiments/build_prompt_catalog.py
python3 docs/research/jev-experiments/build_report.py
```

- [Protocol and ownership](../jev-experiment-protocol.md), [worker lifecycle](coordination.json), and [predeclared interpretation](interpretation-preregistered.md). Dedicated Herdr workspace: w1J, Jev experiments; pre-existing panes were untouched.
- Main inputs, selected prompts and raw logs: discovery/, discovery-extra/, routing/, evidence/. Each has dataset.json, prompts.json, freeze.json and results/*.jsonl.
- [Evidence audit](review/evidence-live-assessment.md), [routing/skill audit](review/v4-live-assessment.md), [revised-discovery audit](review/discovery-extra-v2-assessment.md) and [final synthesis review](review/final-synthesis-review.md), and machine-readable aggregate/ audit outputs.
- [Independent scorer documentation](review/audit-README.md). Mock selftests validate the experiment machinery, not model capability. No product source changed, so repository source-test gates were not triggered.
