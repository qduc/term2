# Predeclared interpretation and independent checks

Recorded before scored provider calls. This pilot evaluates Choice-based provider behavior on synthetic cases. Lane holdouts are **author-visible**: the prompt author also created the cases. Grok's independent challenge set is authored without access to lane cases, labels or prompts. It must be compatible with frozen lane questions before it can measure transfer; incompatible criteria/state contracts will be reported rather than pooled.

Verdicts per task, selected before observing scored output:
- Promising pilot: at least 20/24 correct held-out answers, paired improvement over the strongest valid simple baseline with two-sided exact McNemar p<0.05, no unresolved material label dispute, and no failure of an explicitly required invariant in tested cases. This supports an advisory follow-up only.
- Conditional fit: at least 20/24 correct but superiority is not established, or fit depends on exclusions/prompt boundaries. State those conditions. For R1/R2, economics always remain untested. Authority-sensitive tasks remain advisory even if perfect.
- Poor fit in tested setting: fewer than 17/24 correct with resolved labels, or repeated failure of the task's essential semantic distinction; specify whether bad labels, ambiguous rubric or model behavior caused the result. A material false-safe/false-complete observation rules out an authoritative use regardless of aggregate accuracy.
- Inconclusive: intermediate results, too few successful attempts, material unresolved label defects, incompatible challenge inputs, or fixture construction too trivial to discriminate.
- Blocked: provider/capability cannot support a valid live experiment. Never substitute fabricated or mock evidence.
These are screening rules, not universal reliability thresholds; zero dangerous errors in a small sample cannot prove safety.

Per task report exact correct/attempted and correct/answered, baseline counts, class counts and recall, Wilson interval, paired win/loss counts, variant selection margin. Differences of <=2 development cases are labelled weak evidence of prompt superiority. Baselines: authored reproducible heuristic, independent token-overlap probe, and development-majority label applied unchanged to holdout where criteria allow. Do not use holdout-majority as a deployable baseline. Do not automatically call a poor baseline strawman if the task warrants conservative abstention; report actual comparisons and policy consequences.

Independent audit: canonical state duplication across splits; nearest-neighbour textual overlap flags; expected option-position distribution; criteria-set counts; baseline reproducibility from only state+criteria; stratified blind relabel sample (at least five per task) before seeing Jev responses; compare reviewer choices with frozen labels, preserve disagreements. Headline score remains original labels, with separately disclosed adjudication sensitivity, never silently rewrite scored expected answers. Sample payload hashes and data-boundary checks. Metrics are recomputed from raw logs, independent of worker summary.

Latency: main held-out single-question requests only, with >10s count reflecting the production adapter's default deadline. Dev shared-state batch latency is separate. Any usage returned is reported without allocating batch tokens arbitrarily to variants. No answer-confidence-as-accuracy claim.

Stability: for each task select first ordinary and first adversarial holdout case in file order, before calls; repeat selected prompt once in original criteria order and once reversed, log outside main holdout. If those tags are absent use first two holdout cases and record fallback. No retuning on these outcomes.

No end-to-end model/effort routing comparison, production replay, long-context stress, multilingual sweep, Score/Noul primitives or calibrated confidence threshold is established by this phase. Explicitly list these limits in the final report; they are follow-up dimensions, not measured successes.
