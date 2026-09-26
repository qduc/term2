# Jev decision models in term2

Research snapshot: 2026-09-19. This initial opportunity inventory preceded the live experiments in [jev-experiments](jev-experiments/). Read the experiment report there for measured task fit and tested prompts; the source-based proposals below are not evidence of production readiness. External sources are first-party TypeSafe documentation and OpenRouter product pages; vendor benchmarks remain vendor claims.

## What the model actually supplies

Jev evaluates textual state against bounded questions and returns typed answers. Several independent questions can share state in one request. Dependent decisions still require application logic or another request; batching does not let one question consume another answer. This suits narrow semantic judgments, not generating code, summaries, explanations, or plans. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

| Primitive | Contract | Useful term2 interpretation |
| --- | --- | --- |
| Choice | One option, probabilities over options, and confidence; up to 255 options | Select a skill, candidate passage, specialist, or failure category |
| Score | Ordered rubric with 2–10 levels; probability-weighted level number, distribution, confidence | Rank relevance, severity, or evidence sufficiency |
| Noul | Probability that a yes/no proposition is true; no separate confidence | Is this candidate applicable? Is an explicit requirement unaddressed? |

Sources: [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul). A fractional Score describes position on the rubric, not a physical quantity or percentage of affected cases. Choice needs an explicit none/other option when the set is not exhaustive. Separate Nouls allow multiple independent matches.

`confidence` measures concentration of the returned distribution. It is **not** a calibrated probability that the selected answer is correct. TypeSafe claims calibrated probabilities, but that does not establish calibration for term2 shell authorization, retrieval, or completion assessment. Preserve distributions, measure domain-specific reliability, and tune thresholds separately for each question and model version. [Confidence](https://docs.typesafe.ai/confidence)

## API, cost, and practical constraints

| Concern | Direct TypeSafe | OpenRouter / current term2 |
| --- | --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | Local `requestOpenRouterDecisions` targets `/api/alpha/decisions`, separately from chat completions |
| Model IDs | `jev-1.13.0`; alias `jev-latest` | Catalog: `typesafe/jev-1.13`; alias `~typesafe/jev-latest` |
| Request | `model`, textual/JSON `state`, map of `questions`; bearer key | Existing adapter sends these fields with an OpenRouter key |
| Input budget | 64k total state plus all questions; 32k state plus longest question | OpenRouter advertises 32k context; do not assume its endpoint accepts the direct API's larger total |
| Price | $0.042 per million input tokens; free output | Same listed model price |
| Limits | Currently 250k tokens/second and 1,200 requests/minute, explicitly subject to change | OpenRouter-specific effective limits and alpha contract need independent verification |

Sources: [TypeSafe API](https://docs.typesafe.ai/api), [TypeSafe models](https://docs.typesafe.ai/models), [OpenRouter Jev 1.13](https://openrouter.ai/typesafe/jev-1.13/), [OpenRouter alias](https://openrouter.ai/~typesafe/jev-latest), and repository `requestOpenRouterDecisions` in [openrouter-decisions.ts](../../source/providers/openrouter-decisions.ts). The OpenRouter alpha route is verified in local code, not a public API reference discovered during this research. Generic OpenRouter chat-compatible marketing is not evidence that Jev works through chat completions.

At the listed input price, 5,000 billed input tokens cost $0.00021; 10,000 such evaluations cost $2.10 before any additional charges. This arithmetic is an illustration, not measured usage. Shared-state batching may reduce repeated input cost; extra questions still consume tokens. The direct API documents 429 rate limiting and 529 overload responses. SDK retry defaults must not silently become retries on term2's critical path. [API reference](https://docs.typesafe.ai/api), [Choice batching](https://docs.typesafe.ai/primitives/choice)

TypeSafe's home page advertises workflow speed/cost multipliers and a 0.114-second example. Those are vendor demonstrations, not term2 latency measurements, provider SLAs, or guarantees for large states. Measure end-to-end p50/p95/p99 from the deployment location, including transport, queueing, retries, validation, and fallback. Routing can be cheap per call yet expensive overall if it breaks prompt caching or provider continuity. [TypeSafe](https://typesafe.ai/)

Jev takes text, not images/audio/video. Direct-model docs say English performs best and other languages need evaluation. Model aliases move: record resolved model IDs and pin versions for comparisons. TypeSafe does not offer per-customer fine-tuning/LoRA in the documented product; domain adaptation is via state and rubrics. [Models](https://docs.typesafe.ai/models)

## Limitations that matter here

TypeSafe explicitly documents literal interpretation, numerical/counting/date errors, trouble with indirection, irrelevant-context degradation, and susceptibility to adversarial text in state. It also documents that separate questions need not obey expected identities: a Noul and a yes/no Choice can differ, and a proposition plus its independently asked negation need not sum to one. Keep arithmetic, permission checks, exact state transitions, and logical invariants in code. It cannot safely become the authority that decides whether its own input is hostile. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

The subsequent local pilot measures accuracy against synthetic labels, not production accuracy, calibration, broad robustness, or net savings. Vendor examples support feasibility of a pattern, not reliability for term2's distribution. Agreement with an LLM reviewer is a compatibility metric, not ground truth.

## Privacy and deployment

TypeSafe's legal overview describes a no-training commitment and enterprise zero-data-retention offering. Its DPA uses purpose-dependent retention rather than a universal short fixed period. Therefore ordinary usage must not be described as automatically zero-retention. Sending through OpenRouter introduces an additional service whose applicable retention/routing terms must also be checked; direct TypeSafe commitments alone do not establish the whole route's behavior. [Legal overview](https://docs.typesafe.ai/legal), [DPA](https://typesafe.ai/legal/data-processing)

For term2, the relevant data includes proprietary code, user instructions, shell commands, logs, filenames, and prior human decisions. A proposal should specify the minimum evidence it sends and an opt-in provider boundary. Local model-only sessions should not silently acquire a remote semantic dependency. Logs should retain enough decision metadata for evaluation without unnecessarily duplicating raw secrets or source material.

## Existing integration

`DecisionQuestion` currently describes Choice questions only. `requestOpenRouterDecisions` sends one request and uses a ten-second deadline. `evaluateDecisionShadow` asks separate risk and authorization questions per requested tool action, validates selected labels and confidence, combines confidence by minimum, and computes `wouldApprove` from labels. It does not apply confidence as an approval threshold or preserve probability distributions in its returned result. These are observed properties, not recommendations to change approval behavior. See [adapter](../../source/providers/openrouter-decisions.ts) and [shadow evaluator](../../source/services/approval/decision-shadow.ts).

The minimum of risk and authorization confidence is not a joint probability of safe authorization. These are intentional shadow simplifications, not defects diagnosed by this research. The surrounding configured shadow path uses `agent.autoApproveDecisionShadowModel` for opt-in comparisons with the existing reviewer. That is the natural evaluation foothold, not proof that Jev should authorize execution. The product's existing permissions and approval policy remain authoritative.

## Opportunity inventory: proposals, not existing features

The seams named below were identified in repository exploration. Their existence does not establish the feasibility or benefit of each proposed intervention; each needs a bounded experiment before implementation.

| Opportunity | Proposed decision and integration seam | Expected benefit and boundary |
| --- | --- | --- |
| Approval advisory | Separate risk, authorization, evidence sufficiency in existing approval shadow | Collect disagreements and escalate uncertain analysis; do not bypass permission checks or infer new authorization |
| Skill discovery | Rank known skill descriptions and test absolute applicability; `agent-runtime/skill-resolver.ts` presently resolves explicit names | Reduce missed useful skills; preserve explicit user selection and allow no suggestion |
| Tool discovery | Rank catalog candidates after exact filtering | Reduce catalog exposure; model selects IDs, while code checks availability and execution permissions |
| Memory/session reranking | Score lexically retrieved candidates; `memory/memory-search.ts` already supplies lexical scoring | Improve relevance without replacing retrieval recall; keep provenance and lexical fallback |
| Model/effort routing | Choose among configured eligible tiers; `agent-runtime/model-resolver.ts` | Potential savings for bounded tasks; evaluate cache loss, quality, continuity, and routing latency |
| Subagent role/model selection | Match task to eligible specialists; `subagents/subagent-role-pool-selector.ts` currently uses round-robin | Improve suitability; retain concurrency, availability, user delegation intent, and role constraints |
| Semantic progress advisory | Judge whether new evidence advances the requested objective; `agent-runtime/run-budget.ts` emits evidence | Better progress hints; never equate semantic uncertainty with permission to stop or kill work |
| Failure triage | Rank likely semantic causes after typed failures; `retry/recovery-policy.ts` | Suggest remediation or evidence gathering; code retains replay safety, retry admission, and retry limits |
| Output relevance | Rank diagnostic sections or retrieved chunks | Improve presentation and context selection; keep raw output accessible, preserve errors and required evidence |
| Compaction salience | Flag constraints, unresolved work, and decisions to preserve; context-compaction boundaries and generated summaries already exist | Supply a preservation checklist; do not replace summaries, delete history, or alter tool-pairing invariants |
| Completion evidence | Score each explicit requirement against observed changes/test evidence | Surface missing verification; never turn a confident label into proof of task completion |
| Notification importance | Classify actionable changes in background results | Reduce noise; preserve explicit notification intent and mandatory failure/action notices |
| Test/review scope | Recommend additional targeted tests or review lenses from a diff | Focus extra effort; never waive repository-required gates or skip deterministic dependency coverage |
| Offline evaluation | Cluster failures, suggest labels, discover boundary cases | Accelerate dataset curation; independently adjudicate labels before treating them as truth |
| Agent-programmable decisions | Expose bounded questions through a proposed `run_code` capability for agent-authored classification, sorting, or selection workflows | Broader than fixed harness decisions; retain ordinary permissions, data disclosure boundaries, usage accounting, and cancellation |
| User-input intent advisory | Classify ambiguous incoming messages for presentation hints | Useful only outside exact control paths; `conversation-input-routing.ts` approval-state routing remains deterministic |

These align with first-party demonstrations of [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion), [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), [bounded function calling](https://docs.typesafe.ai/cookbooks/function_calling), and [intent routing](https://docs.typesafe.ai/patterns/intent-routing). The analogies motivate experiments; the term2 proposals are our inferences.

The skill-suggestion cookbook is especially pertinent: shortlist, inspect top candidates, and permit rejection of all candidates while leaving the agent's catalog intact. Its published run reports wrong skill loads falling from 16.8% to 7.3% and unnecessary loads from 9.8% to 4.0% across 488 single-turn requests, using Jev 1.12 and Claude Haiku 4.5. This is an older-model vendor experiment on Hermes skills, not measured term2 behavior or a guarantee of the same improvement. [Published cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion)

## Recommended order and acceptance evidence

1. **Discovery and retrieval:** compare skill suggestions and lexical-plus-semantic reranking against current behavior on historical, consented examples. Measure relevant-candidate recall, ranking quality, no-match precision, latency, and total cost. Start advisory, retaining existing candidates and provenance.
2. **Existing approval shadow:** preserve per-question probabilities and resolved model version in an evaluation design; compare against independently adjudicated examples. Break down false approvals by destructive effects, authorization ambiguity, and injection attempts. Do not use reviewer agreement as correctness.
3. **Routing:** evaluate fixed baselines versus decision-assisted model/effort and specialist selection. Count completed-task quality, retries, wall time, token cost, cache hits, and continuity failures. Savings must survive the entire task, not just the classifier call.
4. **Other advisory uses:** test completion evidence, failure triage, notification importance, and compaction salience without granting new runtime authority.
5. **Guards last:** any policy that blocks, discards, retries, kills, or approves work needs the repository's guard-design process and evidence for its asymmetric error costs. Typed output and vendor confidence do not supply that evidence.

For every experiment, version the questions and candidate set, retain the baseline, include none/unknown outcomes where appropriate, test stale/missing/malformed responses and provider failure, and make fallback explicit. Evaluate adversarial state, long irrelevant context, ambiguous user intent, multilingual input, and changing model aliases. Keep related questions together only when their state and timing requirements align; avoid a global decision service that accumulates unrelated policy.

A possible shared technical seam is a provider-neutral `DecisionClient` with Choice/Score/Noul request and validated response types, cancellation, usage reporting, and provider adapters. This is a proposal, not the existing choice-only adapter. Approval, retrieval, routing, and other domain owners should retain their own rubrics, thresholds, fallbacks, and policy. Agent-programmable decisions would reuse the transport while remaining an explicitly exposed tool capability, not unrestricted access to internal harness policy.

Open questions before production implementation: OpenRouter alpha schema stability and limits; exact billing for batched questions; route-specific retention guarantees; cancellation and background-work ownership; domain calibration; and measured latency/savings. None is resolved by the research snapshot alone.
