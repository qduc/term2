# Jev task-fit experiments

Status: completed research pilot in dedicated Herdr workspace w1J (Jev experiments), 2026-09-19. All 20 task families are scored and independently reviewed. See [integrated findings](jev-experiments/README.md) and [tested prompts](jev-experiments/prompt-catalog.md). This document preserves the planned breadth; the actual scope and deviations below govern interpretation.

## Objective and authority

Evaluate every opportunity in `jev-decision-model-opportunities.md` and the accompanying 20-row conversation inventory. Produce reproducible live-provider evidence, a task-fit verdict, and effective prompt candidates where supported. The user authorized experiments using new interactive term2 workers in Herdr. This is research, not authorization to activate a new production policy or modify runtime behavior.

Run ID: `jev-fit-20260919`. Coordinator: the current Codex task, outside Herdr. Existing Herdr panes are protected and are not worker candidates. New worker tabs must not take focus. The workers use Jev through its decision API as the subject; their own coding/research model is a separate, user-confirmed choice.

## Dependency graph and ownership

```text
P0 protocol + user-selected worker pool/target
  -> P1 shared runner + live API smoke + independent runner verification
  -> D discovery/retrieval experiments
  -> R routing/coordination experiments
  -> E evidence/control-advisory experiments
D + R + E -> V independent evidence review
V -> S coordinator synthesis and prompt catalog
```

P1 precedes all scored API runs; dataset and rubric authoring can proceed concurrently. D, R, and E own disjoint artifacts. The coordinator owns shared infrastructure and integration. Workers may propose runner changes but must not race to edit the shared runner. No nested workers without a new explicit assignment.

Confirmed distributed pool: GLM 5.3 Flash through term2 **zai** provider for discovery; GPT-5.6 Terra through term2 Codex for infrastructure and routing; GPT-5.6 Sol through term2 Codex for evidence tasks; Claude harness with Opus 5 for independent review; Grok harness with its default model for independent challenge cases. User explicitly chose a new workspace, distributed harnesses, zai for GLM, and no model override for Grok. Grok CLI catalog reported unauthenticated; actual interactive Grok 4.6 subsequently acknowledged the brief and used tools successfully. Worker model identity and admission are checked from live panes; quota/reset telemetry is recorded where exposed, not assumed.

Research writers have disjoint artifact directories under docs/research/jev-experiments/. They may not modify source, settings, existing tests, or each other's artifacts; no runtime feature is being developed. P1 infrastructure authoring is delegated to an isolated writer, with coordinator ownership and verification before bulk calls. Independent challenge author C adds four held-out cases per task, authored without reading lane datasets, to examine label/prompt overfitting.

## Coverage matrix

| ID | Lane | Task | Primary evidence |
| --- | --- | --- | --- |
| D1 | D | Skill selection | Correct candidate and abstention on no-fit cases |
| D2 | D | Tool/MCP discovery | Relevant eligible tool ranking, including absent capabilities |
| D3 | D | Memory retrieval | Relevant-candidate ranking and recall |
| D4 | D | Session retrieval | Ranking relevant prior task excerpts with provenance |
| D5 | D | Code/search results | Ranking candidate files/passages with known relevance |
| D6 | D | Output selection | Retention/ranking of essential diagnostic evidence |
| R1 | R | Model selection | Routing-label screening; end-to-end outcome evidence required for savings claims |
| R2 | R | Reasoning effort | Routing-label screening; actual task outcomes required for quality/cost claims |
| R3 | R | Subagent selection | Appropriate eligible role/model for a stated capability catalog |
| R4 | R | Delegation advice | Independence and coordination-cost judgments against explicit task constraints |
| R5 | R | Incoming-message interpretation | Correction/follow-up/new-topic classification; exact approval controls excluded |
| R6 | R | Agent-programmable decisions | Batch classification and ranking through a standalone experimental workflow |
| E1 | E | Approval review | Risk and authorization separately; false approval rate by challenge class |
| E2 | E | Failure triage | Cause/remediation classification without executing recovery |
| E3 | E | Progress assessment | Productive repetition versus genuinely unchanged failure evidence |
| E4 | E | Completion checking | Detection of missing requirements and unsupported completion claims |
| E5 | E | Compaction preparation | Recall of must-preserve constraints, decisions, and unresolved work |
| E6 | E | Background notifications | Actionable-change recall versus unnecessary notifications |
| E7 | E | Test/review targeting | Relevant supplemental coverage; no waiver of required gates |
| E8 | E | Offline evaluation | Useful failure categorization; label correctness judged independently |

## Experimental method

1. Pin the advertised OpenRouter Jev model ID (`typesafe/jev-1.13`) and record the resolved response model when supplied. Record actual endpoint, question schema, dates, code revision, and dataset/prompt digests. Do not substitute a chat model silently if the decision endpoint fails.
2. Each task starts with at least 24 development and 24 held-out cases. Include straightforward positives, close alternatives, insufficient evidence/no-fit cases, and counterexamples. Use repository-backed or realistic handcrafted fixtures; explicitly label synthetic data and provenance. No private historical conversations without separate data authorization.
3. Freeze labels and splits before querying Jev. Keep answer keys out of model state. Record the label rationale and ambiguous cases. Development and held-out cases must differ in substance, not merely in names. This sample size is a screening pilot, not evidence of production-grade reliability.
4. Compare a simple task-specific baseline against at least three prompt variants: minimal literal question; explicit atomic rubric with boundary cases and unknown/none; evidence-scoped rubric separating data from instructions. Candidate selection may compare Choice with applicability Nouls; rank tasks may compare Score with pointwise relevance. Do not force all primitives onto every task.
5. Tune only on development cases. Freeze the selected prompt before scoring the held-out split. If a holdout result motivates changes, record that split as consumed and create fresh cases before claiming generalization. Retain losing prompt results.
6. Use prompt-development failure analysis to identify omissions, wording sensitivity, state overload, inappropriate primitive selection, and label ambiguity. Repeat a predeclared subset to observe answer stability. Balance answer order on selected cases to detect position dependence.
7. Separate transport/schema failures from task errors. Preserve successful and failed attempt records, status, request/response correlation, elapsed time, usage when returned, and sanitised errors. Never manufacture responses, measured costs, or latency. Missing billing fields remain unknown; estimates must be labelled.
8. Batch independent questions only when they share relevant state and the endpoint accepts the schema. Do not batch distinct test cases in a way that leaks their labels or allows one case to influence another. Bound request concurrency and stop launching new calls when the planned experiment is exhausted; preserve partial results.

## Actual scope and recorded deviations

The implemented main experiment uses **Choice, one question per request**, with 24 development and 24 author-visible holdout cases for each of 20 tasks. It selects one supplied candidate or classification label. The ranking, recall, Score/Noul, multi-question batching and end-to-end workflow outcomes in the original coverage plan were not measured; top-1 accuracy must not be described as those metrics. R6 narrowed to workflow-admission classification, and 47/48 of its fixtures supply narrated options rather than inspectable candidate lists. E1 scores risk and authorization separately, not a joint approval outcome.

The original GLM high-effort discovery session produced no dataset; it was cleanly restarted in the same dedicated pane with medium effort and bounded D1 scope. Grok, using its default model with no override, subsequently authored D2–D6 after its independent challenge had been frozen. That challenge therefore is not independently authored relative to D2–D6. No challenge cases were reused. The GLM worker used **zai**; Jev itself was the separately specified decision-endpoint subject.

D1 criteria that leaked applicability were corrected before live calls. D3–D6 initial fixtures had answer-position and text-specificity shortcuts and were rejected before calls; both their candidate content and ordering were revised, preserving the rejected dataset for audit. The revision uses case-ID-derived ordering, independent of expected labels. A fresh reviewer receives the revised discovery sample without labels before inspecting lane data. Review does not make author-visible holdouts sealed or human-adjudicated.

Development selection uses correct/attempted with failures included; ties prefer scoped, then rubric, then minimal. No retry replaces a failed observation. Each lane freezes inputs and selection before its first holdout request. The strongest baseline is the maximum of the reproducible authored heuristic, independent lexical probe and development-majority predictor. Interpretation follows the unchanged [preregistration](jev-experiments/interpretation-preregistered.md). Post-hoc first-position and longest-candidate diagnostics remain explicitly exploratory.

Stability uses an ordinary and an adversarial case per task in file order, repeating the selected prompt and reversing criteria order. Main fixtures for E2/E6/R3/R4/R5 lacked an adversarial-tagged case; recorded pre-call amendments omit that missing case rather than apply the original fallback. Candidate order inside state is not reversed. The separate challenge runs its own scoped prompt, so it is not evidence that every selected main prompt transfers.

## Metrics and verdicts

- Classification: per-class precision/recall, confusion matrix, abstention and coverage, and selected-versus-baseline paired results. Report counts as well as percentages.
- Ranking: recall at the chosen shortlist size and reciprocal rank or NDCG when labels support it. Preserve no-fit cases and required-evidence recall.
- Authority-sensitive advisories: enumerate false safe/authorized/complete judgments and test prompt injection. A zero-error small sample cannot authorize production activation.
- Operations: end-to-end latency distribution, API failure rate, observed/estimated cost, and fallback behavior. Report effective sample count for every aggregate.
- Routing economics: subjective routing labels establish only rubric agreement. Demonstrating better routing requires executing representative tasks under fixed and routed configurations and comparing independently verified outcomes, total cost, latency, retries, and continuity. If that stage is absent, label the economic claim untested.
- Verdict vocabulary: `promising pilot`, `conditional fit`, `poor fit in tested setting`, `inconclusive`, or `blocked by provider/capability`. Every verdict names its tested scope and the evidence that could change it. Do not turn pilot accuracy into a universal fit claim.

## Deliverables and verification

Each lane supplies its dataset, frozen prompts, runnable experiment script/configuration, raw sanitized JSONL results, aggregate metrics, and a Markdown analysis for each assigned task. A prompt catalog includes exact instructions, criteria, state schema, primitive, known failure cases, abstention behavior, and version identifiers.

Workers write only inside their assigned isolated research directory/worktree. They may read production code but must not change production source, settings, credentials, or existing tests. Dangerous shell strings are JSON data only and must never be executed. Use credentials in-process without printing or persisting secrets; do not copy credential stores into artifacts.

The coordinator independently validates schemas, recomputes metrics and digests, checks unique IDs and split separation, inspects request payloads for label leakage, verifies prompt-freeze order, and checks that every cited provider response is real and attributable. Independent review inspects dataset quality and conclusions, not merely script exit status. Do not launch the repository full suite for research-only artifacts.

Before dispatch, each brief must fix its worker identity, exact touch set, absolute return-receipt path, task ID, coordinator-supplied verification argv, and no-child policy. Workers acknowledge the assignment and report a completion receipt with run/task/worker IDs, artifact path, SHA-256 digest, exact verification argv and result, declared children/background work, and unresolved limitations. The terminal is a return-only reporting surface; lifecycle waits wake the coordinator to inspect the receipt and do not establish correctness.

Keep lifecycle states distinct: prepared, admitted, finished, verified, accepted, integrated. New experimental results remain research artifacts; production activation is outside this assignment.
