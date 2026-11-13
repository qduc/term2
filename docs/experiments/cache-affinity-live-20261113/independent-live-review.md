# Independent live evidence review

Accept the native accounting, header-only relay invariants, and retained artifact integrity. Reject a capability-preserving A/B interpretation. The affinity hypothesis is **inconclusive**: the cohort stopped after one completed pair and one interrupted treatment run because its shell sandbox lacked `socat`. Neither completed agent could execute its requested public tests through the available approval path.

Tested product/build receipt identifies commit `5c5488ccda595677c27df11b84bd971a1ed67824` (unchanged experiment harness recorded in protocol.json). No independent inference calls were made. The audit ran only after `active.lock` disappeared; stopped coordinator metadata is retained. This review does not independently establish OS process termination from the metadata alone.

## Independently reconstructed native measurements

| Run | Requests | Native input | Cache read | Cache write | Native output | HTTP time | Usage-priced USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pagination baseline | 11 | 87,773 | 77,071 | 10,669 | 3,780 | 51.629 s | 0.003997635 |
| Pagination affinity | 8 | 59,763 | 49,972 | 9,767 | 4,093 | 44.989 s | 0.003769495 |
| Classifier affinity, interrupted | 5 | 30,794 | 23,628 | 7,151 | 2,198 | 22.108 s | 0.002230655 |

All **24 physical native requests** have reconciled terminal usage and HTTP 200. Independent integer-nanodollar pricing totals **$0.009997785**, with **$0 uncertain exposure**. This is an estimate from confirmed native token counts at published standard rates, not a confirmed provider invoice. No fixture charges enter this total. HTTP time sums request start-to-finish durations, rather than model generation-only latency or whole task time.

The interrupted classifier run is spend and evidence, never a matched comparison. Its partial source artifact and hashes are retained; coordinator-buffered stdout was not flushed on termination, and completion/capability success is not inferred.

All three runs have zero cache-read-miss continuations and derived cumulative cache writes minus largest cached-plus-written context equal to zero. The earlier cache-rewrite symptom therefore did not reproduce in either arm of the only completed pair. The pagination affinity arm used fewer requests and lower cost in this pair, but different stochastic trajectories, sandbox failures and denied test requests prevent causal savings attribution.

## Transport and accounting checks

The independent script separately reparsed all terminal native usage and priced each request with integer arithmetic; all ledger prices reconcile. Every relay incoming-body hash equals its outgoing-body hash. Only treatment outgoing headers carry `session-id`, equal to the existing body cache key; the allowlisted other headers remain equal. The initial request bodies of the two pagination runs are exactly equal after removing their independent `prompt_cache_key` values.

Every continuation chains the immediate preceding response ID, retains its conversation cache key, omits `store`, and avoids repeating `additional_tools`. All requests use native `gpt-6-luna` Responses over streaming HTTP, medium effort (including native configuration), and a 32,000 output ceiling. No production code or replay strategy was changed.

Retained artifact hashes reconcile for both completed runs and the partial run. Independent network-isolated regrading reproduces **14/14** frozen checks for each completed pagination artifact. This is external artifact verification, not proof the agents ran their requested tests. Both completed traces show skill content returned, but **zero successful agent-executed public-test results**.

## Capability guardrail failures

| Run | Missing-socat shell results | Requested unsandboxed shell calls | Denied public-test calls |
| --- | ---: | ---: | ---: |
| Pagination baseline | 2 | 3 | 2 |
| Pagination affinity | 1 | 3 | 2 |
| Classifier affinity, interrupted | 1 | 0 | 0 observed |

Baseline public-test requests were denied as YELLOW without a configured approval model. Affinity had one RED focused command denial and one YELLOW public-test denial. Another baseline inspection returned exit 128 because the synthetic task directory was not a Git repository. These outcomes remain counted; no guarded command was made executable by this verifier.

The external 14/14 scores cannot rescue the failed capability-preservation criterion. Complete a no-cost real-tool preflight after repairing the environment and approval setup, then predeclare a new balanced cohort if still warranted. Do not continue inference on the current broken environment or combine future repaired runs with these arms as one clean A/B.

Reproduce the accounting audit without provider calls:

```sh
python3 independent-live-audit.py /path/to/settled/cache-affinity-live
```

Supporting outputs: `independent-live-audit.json`, `independent-live-audit.py`, and `independent-regrade.json`. Hosted CI was not run. The sample is too small and incomplete to support a general routing recommendation.
