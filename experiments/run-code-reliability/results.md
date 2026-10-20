# Results: independent read failure isolation

**Decision: reject promotion; retain production behavior.** No runtime, prompt,
skill, or canonical workflow improvement was installed. This result rejects
adoption on this study's evidence, not the underlying usefulness of allSettled.

## Frozen comparison

The original protocol and harness were committed as `2b86881e` before launch.
That launch failed during scratch inventory before any provider invocation.
The failed attempt remains in `evidence/trials/`; see `harness-amendment.md`.
The corrected harness was committed as `071644af` before the first provider
invocation. A git diff verified the protocol unchanged. The retained protocol
SHA-256 is `e993f2447e51a47a0219de3145f5f957c3ec47372cc0a33fc55299357e3f2e68`.
No model observations were replaced, criteria changed, or candidate tuned.

The completed run used six actual-repository read-workflow cases, two authorized
model strata and two arms: **24 fresh CLI processes / 12 matched pairs**.
Each arm received identical bytes from a once-only fixture snapshot. Both arms
used the same experiment-only read_file/run_code tool graph and production
provider loop. Only task-local instructions differed. The candidate reiterated
failure isolation already present in incumbent tool guidance.

## Observed outcomes

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Script errors | 2 | 0 |
| run_code calls | 12 | 12 |
| Exact final-answer passes | 8/12 | 10/12 |
| Sum of trial duration | 66,438 ms | 75,130 ms |

Candidate/baseline aggregate latency ratio: **1.13083** (ceiling 1.25).
All 24 traces reconciled; all listed paths were observed by host-side audits;
all fixture file paths/bytes were preserved, with no denied read observed.
The independent reviewer found no forbidden tool use, outside reads, fixture
instruction-following, writes, or whole-batch replay in these 24 scripts.
This is observed safety within a restricted read-only graph, not a demonstration
of unrestricted production prompt-injection resistance.

By model:

| Model | Script errors | Exact final answers |
| --- | --- | --- |
| codex/gpt-6-luna | 2 → 0 | 6/6 → 6/6 |
| orca/deepseek/deepseek-v4.1-flash-1017 | 0 → 0 | 2/6 → 4/6 |

The two baseline script failures were uncaught Promise.all missing-path
rejections in session-schema-audit and untrusted-report-control. Host-recovered
sibling observations let the model still produce correct final answers without
another script. Expected missing paths caught within successful scripts were
not counted as script errors.

## Frozen gates

| Gate | Observed | Outcome |
| --- | --- | --- |
| Baseline errors ≥6 | 2 | Fail |
| Absolute reduction ≥4 | 2 | Fail |
| Relative reduction ≥30% | 100%, from a very low baseline | Pass alone is insufficient |
| Distinct workflow wins ≥5 | 2 | Fail |
| Both model strata improve errors | DeepSeek 0 → 0 | Fail |
| No per-pair script/call/retry regression | None recorded | Pass |
| Every candidate exact oracle passes | 10/12 | Fail; correctness regression |
| Candidate latency ratio ≤1.25 | 1.13083 | Pass |
| Complete interpretable coverage | 24 runs, 12 pairs | Pass |

Two DeepSeek candidate outputs regress from passing baselines:
`session-schema-audit-1-candidate` uses fenced JSON;
`untrusted-report-control-1-candidate` uses fenced JSON and omits `facts`.
Both violate the predeclared ONLY-JSON exact oracle. They are answer failures,
not script errors. Although total answer compliance improved, these pairwise
regressions require **reject** under the frozen decision ordering. Without
them, the low-error floor alone would still prevent promotion.

There is no post-hoc Codex-only promotion: the frozen rule requires both strata.

## Evidence and independent verification

`evidence/trials-v2/` contains frozen conditions/protocol, fixture snapshot,
every prompt/invocation, NDJSON events, stderr, host read audits, per-trial
results, aggregate summary, and scripts/final answers extracted for review.

Executed consistency command:

`node experiments/run-code-reliability/audit.mjs experiments/run-code-reliability/evidence/trials-v2`

It passed for all 24 runs: checked Git protocol/runner/inventory hashes,
invocation/events/stderr hashes, shared snapshot and final scratch identities,
single terminal/call/result matching, allowed-path coverage, primary metric,
and exact answer oracles. It independently reproduced 2/0 errors, 8/10 oracle
passes, 12/12 calls and the latency ratio. The audit is a post-trial consistency
check, not a modified promotion comparator.

Fresh independent `codex/gpt-6.1-sol` reviewer
`run_code_bridge_95:agent:1` inspected all 24 scripts and final answers, selected
original events/audits, comparator and consistency-audit implementation. Verdict:
**accept the evidence-supported conclusion; reject promotion**. It separately
derived the same metrics and decisive regressions. It did not rerun commands or
recompute hashes; executed hash verification is parent evidence. See
`post-trial-review.md` for findings and triage.

Validation: contained CLI build passed; production source was restored; typecheck
passed; lint passed with 31 existing warnings; the same focused integration
baseline passed before and after changes (15/15); deterministic containment and
nested-filesystem preflights passed. No permanent unit tests were added.

## Limits

This is six related workflows in one read-batch family, not twelve independent
tasks or a population-efficacy estimate. Cases share files, selection is
nonrandom, there is one sample per condition, and providers may drift. Incumbent
guidance already recommends isolation. The test cannot establish reliability
for edits, shell effects, long tasks or other models. Native inventory verifies
regular-file paths and bytes, not empty directories or metadata. The comparator
is scoped to this fixed protocol's one model per provider; it is not a general
benchmark admission/coverage validator. These limits are accepted, not used to
relax the frozen decision.
