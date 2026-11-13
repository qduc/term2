# Independent repaired-cohort live review

**Accept the native accounting, transport isolation, protocol adherence and observed capability guardrails. The causal affinity/savings conclusion remains inconclusive.** The clean cohort provides a favorable cache-rewrite signal, not sufficient evidence for a production default or general efficiency improvement. No further paid work is needed to report this bounded result.

Tested full revision: `7d58e97cca77734c3595f824d54667ac19f84bcb`. Product source/package/lock remain equivalent to PR271 `b1c2e4df329a371d2867f4224ba72ca83220e8a4`; experiment harness and build identity use the full revision above. The build receipt has input digest `45ebe693879120e1aa93f8fbdcc4ea5c235586871a6c30ce93eca051552de430` and output digest `3ce1bb962c7c5295bd9cf6d2c231c3fa70b667defeeda4b1d45cea30a4d174df`. The current four-exchange no-cost real-tool preflight passed on the matching receipt before live execution.

The independent final audit ran after the coordinator lock disappeared and all twelve clean run outcomes were finalized. The verifier made no inference calls, rebuilds, ledger/source edits or remote writes.

## Native measurements, clean cohort only

| Measure | Baseline | Explicit session affinity |
| --- | ---: | ---: |
| Task runs | 6 | 6 |
| Physical HTTP requests | 63 | 67 |
| Native input tokens, inclusive | 519,647 | 565,704 |
| Native cache-read tokens | 432,767 | 495,087 |
| Native cache-write tokens | 86,691 | 70,416 |
| Derived fresh input tokens | 189 | 201 |
| Native output tokens | 25,400 | 27,456 |
| Derived writes above largest cached+written context | 15,538 | 0 |
| Zero-cache-read continuations | 2 | 0 |
| Sum of physical HTTP durations | 327.971 s | 354.539 s |
| Sum of child task durations, grading excluded | 338.557 s | 365.544 s |
| Native-usage price estimate | $0.027882945 | $0.027500970 |

The clean cohort comprises **130 requests**, priced at **$0.055383915**. All **154 cumulative requests**, including the original capability-failed 24, reconcile to **$0.065381700**. The prior amount is **$0.009997785** and **uncertain exposure is $0**. These are estimates from confirmed native usage at standard rates, not confirmed invoice amounts. No scripted fixture usage or hosted CI enters live counts or spending. Failed-quality artifacts and natural repair requests remain included.

Treatment cache writes are 18.7736% lower, but requests are 6.3492% higher, native output 8.0945% higher, summed HTTP time 8.1007% higher, and child time 7.9712% higher. Aggregate cost is only **1.3699% lower**, a difference of **$0.000381975**. Exactly three paired costs favor treatment and three favor baseline; cache-rewrite excess favors treatment in two pairs with four ties. These mixed efficiency outcomes do not establish a reliable overall savings effect.

The cost difference decomposes as $0.002034375 less for cache writes, offset by $0.000623200 more for cache reads, $0.001028000 more for output and $0.000001200 more for derived fresh input. This is billing arithmetic, not a counterfactual estimate of recoverable savings.

## Cache observations and causal limits

The two baseline zero-read continuations are request `00107` (classifier repetition 2), beginning **288 ms** after the preceding response, and `00152` (JSONL repetition 2), beginning **20 ms** after the preceding response. Their native cache-write counts are 5,709 and 9,966. Treatment has no zero-read continuation in its 61 continuations; baseline has two in 57. Requests within a run are correlated, so these are not independent 118-trial observations.

Every initial request reports zero cache reads. Initial matched bodies are byte-equivalent after replacing their independent cache keys; this holds across repetitions for each task. One baseline classifier repetition nevertheless reports **20 additional native initial input/cache-write tokens** (5,575/5,572 versus 5,555/5,552). Retained bodies establish no corresponding payload difference. Preserve this unexplained provider-reported variation rather than assigning it to harness payload changes or assuming exact tokenization invariance.

Six matched pairs across three constructed tasks, with balanced alternating arm order, are stronger evidence than a single uncontrolled trajectory. Still, only two rewrite events distinguish the arms, both in repetition 2, while model trajectories and output lengths differ. The provider's internal routing affinity semantics remain undocumented in this investigation. No backend routing identifier establishes mechanism. The evidence supports a **directional cache hypothesis** but leaves general causal attribution and reliable net savings **inconclusive**.

## Isolation, integrity and protocol checks

The independent Python audit reparsed native terminal usage and priced every physical request using integer nanodollars. All ledger prices reconcile, all requests are metered HTTP 200, and no unresolved request remains. The original first 24 ledger entries match their retained SHA256 snapshot exactly.

All 154 retained request bodies independently reconstruct their original raw compact-JSON SHA256. Each incoming request-body hash equals its outgoing hash. All treatment headers have `session-id` equal to the existing body cache key; no control header does, and allowlisted other headers are unchanged. Every continuation chains the immediately preceding response, retains its cache key, omits `store`, and avoids repeating `additional_tools`. Native model, streaming HTTP, medium effort (including native configuration), 32K output ceiling, task seeds, prompts, tools, settings and source boundaries remain fixed across arms. Realized order exactly matches the preregistered twelve-run order.

No replay-strategy, production provider default, approval policy or sandbox setting was changed to obtain these results. The socat PATH repair remains experiment-local and uses the existing configured binary.

## Capability and artifact guardrails

All twelve clean native traces independently establish the required skill read and successful shell public-test execution, including the immutable named public cases, exit 0, positive pass count and zero failures. No missing-socat results, approval-denial results, unsandboxed shell requests or unauthorized protected-seed changes occurred. The real edit/shell/test path therefore passed the exercised capability guardrails. Natural task-level test failures and repairs remain in usage; the audit records their tool errors without conflating them with unavailable capabilities.

Independent network/PID-isolated regrading of copies of all twelve retained artifacts reproduced every saved rubric result exactly. Baseline passes **5/6 complete rubrics**, treatment **4/6**; both pass **103/106 individual frozen checks**. Failures are classifier contract errors. Equal individual totals do not establish equal quality, and these tasks do not exercise all offered capabilities, delegation, or every approval path. Do not claim task-quality equivalence or capability completeness.

The original stopped two completed runs and partial classifier run remain historical capability-failed evidence and cumulative spending. They are excluded from clean arm comparisons. Their later no-cost PATH repair does not retroactively validate them.

## Next step and reproducibility

Keep production defaults unchanged. The bounded experiment is complete; it provides a reproducible small-sample cache signal and mixed net-efficiency results. If more evidence is later warranted, preregister a separately authorized discriminating test of affinity versus replay/cache semantics, retaining native counters and actual capability checks. Avoid an open-ended repetition campaign or promising the prior diagnostic gap as recoverable savings.

Reproduce the independent accounting/protocol/capability audit without inference:

```sh
python3 clean-live-audit.py /path/to/settled/cache-affinity-clean-r1
```

Supporting files: `clean-live-audit.py`, `clean-live-audit.json`, and `clean-live-regrade.json`. The regrade used credential-free, network/PID-isolated copies and did not modify retained artifacts. Hosted CI was not run. Provider invoices and internal backend routing telemetry are unavailable.
