# No-unit-test experiment: interim results, 2026-10-24

**Assessment:** the hypothesis remains **unresolved**. The available evidence does
not demonstrate lower total delivery cost, and does not establish unchanged
quality. Recommend **continuing with tighter verification and measurement until
the scheduled decision**, not declaring success or restoring the suite now. The
human owns that decision; this assessment changes no testing policy.

**Evidence cutoff:** 2026-10-24 **06:53:25 Asia/Ho_Chi_Minh**
(2026-10-23T23:53:25Z), not the whole local day. Source checkout and primary HEAD
were both `12dabc925efc1b72a63b885829a05c38a437ef69`. The adjacent
[JSON](interim-results-2026-10-24.json) contains frozen identities, read times,
SHA-256 hashes, row-level classifications, denominators, sample identities and
queries' parameters. Later primary edits and test runs are outside this cutoff.

## Decision in brief

| Question | Assessment | Evidence / qualification |
| --- | --- | --- |
| Has total effort/cost fallen? | **Not established** | No comparable baseline task durations or repair costs; verification tokens missing in 66/71 activities. Recorded minutes are not measured active runtime or invoices. |
| Has quality stayed meaningfully equivalent? | **Not established** | Six linked product/coverage findings after reported completion across four delivery tasks; incomplete attribution and no validated baseline defect rate. |
| Has the experiment ended? | **No** | README says the **later** of November 5 or 30 completed tasks. Nominal task threshold is exceeded, but the date is not. |
| Is immediate full rollback supported? | **Not by this evidence** | Neither a repeated same-mechanism escaped-regression trigger nor comparative deterioration is established. This is not evidence that deterioration is absent. |
| What next? | **Adjust verification and measurement** | Resolve pending high-risk acceptance, require failure-path evidence tied to the accepted revision, and distinguish deliveries from studies and reviews. No new guard or policy change is implemented here. |

The strongest counterweight to continuation is real: deletion directly broke a
scheduled catalog workflow, and independent acceptance did not prevent several
subsequent product/coverage findings. Missing measurement can conceal a meaningful
decline. Conversely, an unmerged unsafe assembly migration was rejected by
independent verification, demonstrating that some serious defects were caught
before production delivery. Neither example establishes relative cost-effectiveness.

## 1. Sources, scope and definitions

Read `AGENTS.md`, the experiment README, investigation, verification,
writing-docs and debugging-logs methods. Inspected both ledgers, their git
history, the retained test-result index, historical review/verification reports
and baseline session metadata. No production code, tests, CI, guards, dependency
manifests or shared settings were changed; no paid benchmark or product suite was run.
The first formatting command automatically bootstrapped worktree-local pnpm
dependencies; they were needed for the repository's documentation commit gates.
Other agents' worktrees and Claude sessions were not inspected.
At the frozen revision, the experiment directory contained only the README and
two ledgers: there was no prior dedicated results report. The README's baseline
proxies and the retained task/review evidence are not an earlier matched analysis.

Important source identities:

- Experiment removal: `0b14b6c65191dff3b447cb34ab2b8ed23c86b16c`;
  start merge `03e54f49ecedbb81c440149409c9fd56eeadb76a`
  (October 8, 20:21:33 +07).
- `unit-suite-baseline` is an annotated tag:
  tag object `4d1b517c05b9512d568417f95e72d79f1ab4f7ff`,
  peeled commit `309ef54384973ecaf2e9c8487e274e2afd3a8378`.
- Committed task ledger SHA-256
  `730776fd3f255dcdf1f8b6b7c3470f738adfd30af81be0c069f584a5dee2be89`.
- Primary working task ledger SHA-256
  `ac39657bd087e09972dc79c2d099f9990b412e952a8ca50108f7ac75b9580dfe`.
  It had **six uncommitted additional rows**, not six extra confirmed production
  deliveries. They are retained as explicitly uncommitted evidence in JSON,
  deduplicated by `id`; all committed objects match the primary snapshot.
- Defect ledger SHA-256
  `9c0f9ad25d8b7a19ea4f33c3c29f4ee92a9c62c0391406009c4bff820a932990`.
  Primary and committed copies matched. Blank lines are excluded from counts.

An **activity** is one unique nonblank task row. A **reported delivery** is a
behavioral or test-infrastructure delivery after excluding documentation/workflow
work, studies/prototypes, verification-only activity and four explicitly
unresolved delivery-verification records. This is an analytical denominator,
**not an audit certifying every delivery correct or merged**. In particular,
19/43 delivery rows have null `commit`; one other activity names an unavailable
commit (`0425b5a1`). Raw rows and category assignments remain queryable.

The four unresolved rows concern the initial logging-failure fix, two follow-up
logging repairs, and rollover queued-submission repair. Their evidence says
independent acceptance or task-specific red/green proof remained pending.
A high-risk adaptive-verification review-fix row also says `independent:false`;
it remains in the reported-delivery cohort, exposing rather than hiding that
acceptance gap. Thus **43 is not a strict accepted-task count**. It makes the
30-task threshold nominally met without treating all 71 activities as deliveries;
the threshold needs reconciliation before the final decision.

This report's own documentation record is after the frozen cutoff and is
excluded from these outcome metrics.

## 2. Work delivered and effort observed

| Metric | Committed activities | Committed reported deliveries | Pending-inclusive reported deliveries |
| --- | ---: | ---: | ---: |
| Records | 71 | 43 | 46 |
| Risk: high / medium / low | 37 / 16 / 18 | 28 / 13 / 2 | 31 / 13 / 2 |
| Timestamp spans known | 61/71 | 41/43 | 44/46 |
| Median recorded span, minutes | 11.63 | 12.67 | 13.25 |
| Mean recorded span, minutes | 23.23 | 27.47 | 27.75 |
| Verification minutes known | 45/71 | 31/43 | 34/46 |
| Sum of known verification minutes | 650.8 | 535.8 | 601.8 |
| Mean known verification minutes/task | 14.46 | 17.28 | 17.70 |
| Verification tokens known | 5/71 | 3/43 | 3/46 |
| Sum of known verification tokens | 377,327 | 337,830 | 337,830 |
| Human interventions, sum / known rows | 16 / 70 | 8 / 43 | 8 / 46 |
| Rework rounds, sum / known rows | 33 / 70 | 24 / 43 | 26 / 46 |

Activity type mix: 24 bugfix, 16 feature, 7 refactor, 9 infra, 13 docs, one chore
and one workflow-repair. The narrower 43 deliveries comprise 20 bugfix, 12
feature, 7 refactor and 4 infra. Activity categories are 43 reported deliveries,
16 documentation/workflow, 5 studies/prototypes, 3 verification activities and
4 unresolved deliveries. Pending evidence adds three run-code smoke studies plus
apply-patch, fast-resume and cache-preserving compaction deliveries; it does not
change the recommendation.

### What these numbers do not measure

- `verified_at - started_at` is a **self-recorded timestamp span**, not observed
  model runtime or active engineering effort. Multiple notes explicitly say
  approximate, worktree-creation start, or excluded initial diagnosis/scoping.
  The largest delivery span is 388.39 minutes; it materially affects the mean.
- Verification minutes are also self-reported and inconsistently include
  verifier effort. One approval task explicitly sums 8 executor + 9 verifier
  minutes despite a shorter wall-clock span. **Do not add verification minutes
  to elapsed spans** or call the resulting sum total cost.
- Missing-data rates among activities: timestamp span **14.1%**,
  verification minutes **36.6%**, verification tokens **93.0%**, change size
  **28.2%**, human intervention count **1.4%**. Numerical coverage is not proof
  of consistent measurement. Dollar cost is unavailable; the token field mixes
  verifier and candidate-study scopes. The two large compaction token entries
  are a material share of recorded spend, not evidence of an experiment-wide
  increase.
- Aggregate known verification tokens are **not** total spend. Dividing 377,327
  by all 71 rows would treat missing usage as zero. The known-only mean is
  75,465 tokens across five activities, or 112,610 across the three delivery
  entries; these selectively reported samples are not representative averages.
- Human counts are self-reported; neither human time nor repair effort across
  task boundaries was consistently captured. No baseline trend is established.

## 3. Verification used, and what it caught

For the 43 reported deliveries, exact method labels include typecheck 42,
lint 38, integration-test 31, before-after-comparison 27, provider-black-box 26,
independent-review 21, e2e-test 20, temporary-script 16, fault-injection 12 and
temporary-test 10. Method labels are not normalized: three additional rows use
`integration`, for example. These are **task counts recording use**, not distinct
runs, successful checks or detection rates. The JSON preserves every label.
Twenty-seven of 28 high-risk deliveries record independent verification true;
this checks the field, not the independence or sufficiency of every review.

Observable detection examples:

- Historical session-boundaries verification (`5208151f`,
  `docs/research/session-boundaries/VERIFICATION.md`) exercised replaying an old
  answer against a second retained decision in the same generation, plus
  cloned-address and fresh-answer controls. This caught a miss from an earlier
  single-turn-owner completion; prior fresh-answer tests were insufficient.
- The PR34 review retained at `c71af120`,
  `docs/reports/pr34-completion-verification-review-2026-10-19.md`, found staged
  and untracked quick-check coverage mismatch, undiagnosable unsupported
  workspaces, and absent default-on CLI coverage despite green focused checks.
  The check-set defect was a reproduced mechanism, **not** a demonstrated full
  end-to-end false-completion incident. The same review describes a tool-limited
  verifier returning PASS versus INCONCLUSIVE depending on criterion wording
  despite being unable to execute the check: another reason recorded acceptance
  alone cannot establish equivalent quality.
- The assembly verification activity says the broader migration was unmerged
  and rejected on denial fallthrough, cleanup and hook wiring. The retained
  author's `agent-assembly-implementation-verification.md` nevertheless says
  “Accepted & Verified.” The later bounded-delivery report explicitly excludes
  that migration. This contradiction is an ascertainment warning: an author's
  completion report is not independent acceptance.
- Logging review caught no-transport stderr/retention behavior and a local/UTC
  date mismatch after author completion but **before independent acceptance**.
  Original EACCES evidence did not demonstrate ENOSPC, and an incorrectly dated
  `/dev/full` fixture could pass without exercising the intended sink.

These examples support targeted negative controls and actual boundary journeys.
They do not prove that temporary probes or independent review are cheaper than
the removed suite. There is no systematic method-to-findings ledger with both
positive and negative trials, so **method detection rates are unavailable**.

## 4. Defects: escapes, catches and attribution

The defect ledger has **21 records**: 19 labelled `defect`, 2 `regression`;
7 high, 12 medium and 2 low severity. Discovery sources: agent 9, verifier 5,
user 5 and CI 2. Six records have null task links; three refer to the absent
rejected assembly-migration task. A raw “21/71 defect rate” would mix incompatible
events.

| Analytical classification | Records | Treatment |
| --- | ---: | --- |
| Product/coverage findings linked after reported delivery completion | 6 | Five product defects plus one coverage defect, across four tasks |
| Other unlinked product findings | 3 | Gemini signature, Orca catalog, reference-approval context; introduction not established |
| Setup / cross-branch compile regressions | 2 | Catalog automation and null-check CI failure; different mechanisms |
| Pre-experiment test-infrastructure defect | 1 | Vitest temp leakage since `83ef1184` (September 6) |
| Documentation correction after completion | 1 | Assembly plans, not a production escape |
| Caught in pre-merge independent verification | 3 | Rejected broader assembly migration |
| After author completion, before independent acceptance | 2 | Logging review findings |
| Incident linked to its own repair, not its introducing task | 1 | Rollover crash found at the repair's start |
| Fixture/environment defects | 2 | Explain six approval assertions; not six production regressions |

The six linked post-completion findings are saved-decision replay, shared Orca
filter policy, three adaptive-verification findings, and Bare interactive startup.
That is **13.95 findings per 100 reported deliveries** (6/43), affecting **9.30%**
of delivery tasks (4/43). Excluding the coverage-only finding gives **5/43**,
not six runtime failures. Pending-inclusive normalization is 6/46 = **13.04 per
100**; the numerator has not changed. These are incomplete linked-event rates,
**not an overall quality estimate or a comparison against the baseline**.

Size normalization is possible only for a subset: 35/43 delivery rows report
22,890 changed lines. All six linked findings belong to that known-size subset:
**0.262 per 1,000 reported changed lines**. This excludes eight deliveries,
includes test/doc churn and may overlap changes between tasks. It must not be
presented as the rate across all experimental production code.

### The six approval failures are not six regressions

The frozen `docs/test-results.json` indexes a compaction-feature run at
`b093ad0d`: 217 passed, 6 failed, 1 skipped. The original command record is
incomplete, and exact Node/pnpm versions were not retained. Its failures also
reproduced on unchanged base `258a4d0a`.

The retained independent review
`/tmp/integration-approval-verifier-20261024.md` supplies a stronger controlled
comparison: the original baseline fixture under
`TMPDIR=/tmp/qduc/term2-nodejs` failed exactly six selected assertions; the
fixture-only repair passed seven selected checks under the same environment,
then under a symlinked temp root. Extra scratch-symlink and sibling-prefix
negative controls passed. Five original shell assertions mistook permitted
scratch data for an ordinary victim; the Bare assertion likewise targeted
permitted scratch space. Production confinement policy was unchanged.

The recorded repaired full-suite result was 224 passed, 0 failed, 1 skipped on
a **pre-commit snapshot** later identified with `26f0b0f5`; the independent
reviewer did not rerun the whole suite. Neither that result nor this assessment
certifies a later integrated-primary full-suite run. Counting six assertion
failures as six new compaction or sandbox regressions would contradict the
retained evidence. Count the two fixture defect records separately.

### Lag, repeated classes and surveillance gaps

For the six linked findings, ledger discovery minus prior verification ranges
from **5.14 to 948.42 minutes**, median **36.11 minutes**. This is discovery
latency, not reporting lag or a guaranteed observation window.

JSON records first commit containing each defect and its committer timestamp.
Two logging entries were committed roughly seven hours **before** their stated
UTC discovery times: a material clock/entry inconsistency. Two other small
negative offsets are sub-second precision differences. Actual reporting latency
cannot be reliably pooled; backfilled records and timestamp errors remain.

Approval identity, omitted workflow variants, incomplete evidence scope and
failure-path cleanup recur as broad themes. They are not automatically the
**same kind of escaped regression**. In particular, the two logging findings
are pre-acceptance defects, and the two labelled regressions have different
mechanisms. No retained comparison shows that restored unit tests would catch
these repeated themes more cheaply; that would require a targeted red/green
comparison, not an assumption.

Recent tasks have less follow-up, user discovery is selective, null/mislinked
introducing tasks hide attribution, and some reports claim acceptance that later
records reject. Consequently neither “no more escapes” nor “all defects logged”
is supportable.

## 5. Pre-experiment comparison: a reproducible but incomplete baseline

The README's 279 merge / 170 fix totals are proxies, not tasks and escaped
defects. Recounting reachable history at the frozen HEAD for
**[2026-09-10 00:00 +07, 2026-10-08 00:00 +07)** gives 278 all merges,
237 first-parent merges and 153 non-merge subjects starting `fix`. Window,
ancestry and filtering affect those counts; they should not be used as a
quality denominator.

Executed the documented approximately-30-task approach as far as defensible:

1. Enumerated all 237 first-parent merges in that fixed window, without
   selecting by known outcome. Classified type using branch subjects and
   changed paths; conservatively classified high-risk production paths using
   the repository's provider/session/tool/security boundaries.
2. Excluded synchronization-title merges from selection. Allocated 30 slots
   to available type/risk strata in proportion to the 43 reported deliveries,
   using Hamilton allocation and SHA-256 rank of
   `no-unit-test-interim-2026-10-24-v1:<full-merge-sha>`. The JSON retains all
   frame identities, rules, strata, ranking hashes and the selected 30 merges.
3. Inspected retained session metadata in the baseline window: **205 Codex and
   443 Term2 sessions**, no parse/decompression errors. Of 205 Codex sessions,
   202 retain cumulative usage, but not validated sampled-task usage.
   Baseline app logs were not retained in the inspected log directory (app
   logs began October 17). Compressed Codex sessions were read without installing
   dependencies; only metadata and commit-mention locators were retained.
4. Searched structured events for exact eight-character sample merge hashes:
   **25/30 merges have session mentions**. Mentions include command output,
   prompts, history and journal copies; they do not identify task start,
   independent-verification completion or repair boundaries.
5. For a fixed **14-day follow-up per sampled merge**, inspected later
   non-merge `fix*` commits. There are **146 many-to-many path-overlap candidates**,
   but **zero explicit eight-character introducing-hash references** to sampled
   merges or their introduced branch commits. These are candidate searches,
   not 146 escaped defects or evidence of zero defects.

The attempted match has real limitations: four experimental deliveries occupy
unavailable inferred strata (one low-risk bugfix and three medium/high-risk
infra tasks). Risk inferred from filenames is not the historical agent's risk
label. Some merges bundle work; the selected prompt-probe/audit merges are
studies rather than comparable production deliveries. Selection is reproducible,
but **the result is not a validated matched control cohort**.

No reliable per-task duration, verification cost, intervention count or escaped
defect count was established for the 30 baseline samples. Those values remain
**null**, not zero. Reconstructing whole-session spans or equating overlapping
fixes with escapes would manufacture the desired comparison. This assessment
stops that reconstruction here. Therefore **no credible numerical before/after
cost reduction or quality non-inferiority estimate is available**.

## 6. Ending rule, rollback triggers and confounds

| Rule / trigger | Status at cutoff |
| --- | --- |
| Later of November 5 or 30 completed tasks | Still running. Nominal delivery threshold met; final acceptance count needs reconciliation. No authority to end early inferred. |
| Two or more escaped regressions of the same kind repeatedly missed | **Not established**, not disproved. Only two ledger-labelled regressions, with different causes; do not relabel pre-acceptance logging findings or fixture assertions to satisfy the trigger. |
| Escaped defects/task clearly above baseline after at least 15 tasks | Task count sufficient, **comparison unavailable**. This is an unassessable trigger, not a passed quality gate. |
| Rising human interventions because agents cannot verify independently | **Unassessable** against baseline. Self-reported 16 interventions/70 known activity rows or 8/43 delivery rows is not a trend or causal explanation. |

Rare-event uncertainty remains substantial. Even zero observed events in 43
independent, equally exposed tasks would leave a roughly 6.7% one-sided 95%
upper event probability; those independence/exposure assumptions do **not** hold
here, so this illustration is not a confidence bound on Term2's defect rate.

Confounds include a high-risk-heavy task mix, major conversation/runtime
refactors, changed verification/completion machinery, evolving prompt and tool
profiles, several model/provider families, API response-shape variation,
environmental TMPDIR differences, and improving fixtures and record keeping.
The baseline metadata alone contains many model IDs, including GPT-5.6,
GPT-6/6.1, GLM and DeepSeek variants. Without task-level matching, changes in
agent capability or task selection cannot be separated from unit-test removal.
Product token-efficiency smoke studies in pending rows do not measure the cost
effect of this testing policy.

## 7. Proportionate next steps and human decisions

**Recommend adjusted continuation to the scheduled decision**, with explicit
uncertainty, rather than unchanged continuation or immediate partial/full
restoration. These are recommendations, not implemented policy:

1. Resolve the outstanding high-risk logging and rollover acceptance evidence,
   including the previously incomplete rollover race reproduction. Tie each
   acceptance to exact code/evidence identities and separate author completion
   from independent acceptance. Reconcile the adaptive-verification follow-up's
   missing independent acceptance too.
2. Record author plus verifier effort/usage, failed attempts, human time and
   subsequent repair cost with session links. Preserve unknowns. Separate
   studies/reviews/docs from production deliveries and fix timestamp errors.
   If baseline mappings cannot be supplied, say the final cost comparison is
   inconclusive rather than spend indefinitely reconstructing it.
3. Target observed gaps: interactive **and** headless profile journeys, sequential
   approval replay, full staged/untracked evidence scope, and real fault
   activation plus timezone controls. Broad-suite green remains supporting
   evidence, not the outcome metric.
4. Reconcile introducing-task links and follow-up exposure without silently
   rewriting historical observations. Continue counting discoveries after the
   scheduled experiment date when they trace to experimental work.
5. If repeated accepted-delivery misses concentrate in one area, compare the
   retained boundary tests and relevant tagged unit tests on the same known
   defects. A partial restore becomes defensible if it adds demonstrated
   detection value; the present evidence does not select an area or justify
   restoring all 700 files.

**Questions for the human/controller:** approve adjusted continuation or prefer
a targeted restoration investigation? What cost difference and quality decline
would be material for the decision? Is reliable historical task-to-session,
repair or human-time evidence available? No numeric non-inferiority margin
should be invented retrospectively by this lane.

## Reproduction and validation

The adjacent JSON is the compact evidence product, not a new analysis framework.
Temporary snapshot/index scripts were kept outside the repository; the JSON
retains the sampling rules, query parameters and source identities. Historical
documents removed by later cleanup are referenced by revision and path, not
assumed to exist at HEAD. Machine-local logs may expire; the JSON retains their
hashes and this report retains the discriminating failure signatures.

Useful executed queries:

```sh
jq '.metrics.committed_reported_deliveries' docs/experiments/evidence-driven-development/interim-results-2026-10-24.json
jq '.defect_metrics, .baseline.followup_summary' docs/experiments/evidence-driven-development/interim-results-2026-10-24.json
jq -r '.baseline.sample[].commit' docs/experiments/evidence-driven-development/interim-results-2026-10-24.json
git log 12dabc925efc1b72a63b885829a05c38a437ef69 --first-parent --merges --since=2026-09-10T00:00:00+07:00 --until=2026-10-08T00:00:00+07:00 --format=%H
```

Focused arithmetic/reference validation and independent-review disposition are
recorded in the JSON's `verification` field and the assessment's documentation
verification record. No product-test result is inferred from these checks.
The fresh independent Codex evidence reviewer returned **accept with limitations,
no must-fix error**, independently checking cohort arithmetic and sample selection
and challenging false acceptance and rollback interpretation. Its exact reviewed
artifact hashes are retained. Subsequent source-inventory, time-window hardening
and verification-record additions changed no headline metric or recommendation;
final focused checks cover those additions, not a new product certification.
