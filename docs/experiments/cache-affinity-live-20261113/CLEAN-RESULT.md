# Fresh balanced cohort: cache signal, causal conclusion inconclusive

The fixed clean-r1 cohort finished all **12 runs / 130 native requests**. No guardrail
or uncertainty stop triggered, and paid work is closed. The two older completed
runs and interrupted treatment remain historical; their 24 requests stay counted
in cumulative spending and are excluded from the clean comparison.

**The affinity hypothesis has suggestive directional evidence, not sufficient causal
confirmation.** Control had two zero-cache-read continuations and 15,538 tokens of
derived rewrite excess; treatment had neither. Only two of six pairs were informative
on this measure (both favorable, four ties); correlated requests are not independent trials. Costs split three pairs better and
three worse. Aggregate treatment cost was 1.37% lower, while requests, generated
output and latency were higher. This does not establish a general harness-efficiency
improvement or justify an automatic production default.

## Native measurements and derived arithmetic

| Clean cohort | Baseline | Stable Session-Id |
| --- | ---: | ---: |
| Runs | 6 | 6 |
| Native HTTP requests | 63 | 67 |
| Native input tokens | 519,647 | 565,704 |
| Native cache-read tokens | 432,767 | 495,087 |
| Native cache-write tokens | 86,691 | 70,416 |
| Native output tokens | 25,400 | 27,456 |
| Derived fresh input tokens | 189 | 201 |
| Initial native cache reads | 0 | 0 |
| Initial native cache writes | 32,752 | 32,732 |
| Derived writes minus largest per-run cached+written context | 15,538 | 0 |
| Zero-read continuations | 2 / 57 | 0 / 61 |
| Runs with a zero-read continuation | 2 / 6 | 0 / 6 |
| Summed physical HTTP time | 327.971 s | 354.539 s |
| Summed CLI child time, excluding external grading | 338.557 s | 365.544 s |
| Native-usage cost estimate | $0.027882945 | $0.027500970 |

Treatment-minus-control differences: cost **-$0.000381975 (-1.3699%)**,
cache writes -18.7736%, requests +6.3492%, output +8.0945%, physical HTTP time
+8.1007% and child time +7.9712%. HTTP sums are not per-request latency or TTFT;
child duration includes actual tools and startup. No TTFT measurement is claimed.
All requests were HTTP200 with terminal completed and native usage. This describes
provider exchange completion, not successful task acceptance.

The cost difference decomposes arithmetically into cache-write cost -$0.002034375,
cache-read cost +$0.000623200, output +$0.001028000 and fresh input +$0.000001200.
These are standard prices applied to native counters, not recoverable-savings or
invoice claims. Rates checked on 2026-11-13 at
https://developers.openai.com/api/docs/models/gpt-6-luna and
https://developers.openai.com/api/docs/pricing . Both independent audits price with
integer nanodollars; no displayed per-run rounding is used to sum totals.

## Paired results

| Task / repetition | Order | Control requests / USD | Treatment requests / USD | Control / treatment rewrite excess |
| --- | --- | ---: | ---: | ---: |
| Pagination r1 | control first | 9 / $0.003556530 | 10 / $0.004437305 | 0 / 0 |
| Classifier r1 | treatment first | 9 / $0.004201595 | 12 / $0.005415020 | 0 / 0 |
| JSONL r1 | control first | 11 / $0.004077215 | 10 / $0.003479550 | 0 / 0 |
| Pagination r2 | treatment first | 8 / $0.003632575 | 12 / $0.005056365 | 0 / 0 |
| Classifier r2 | control first | 12 / $0.006709690 | 11 / $0.005299500 | 5,572 / 0 |
| JSONL r2 | treatment first | 14 / $0.005705340 | 12 / $0.003813230 | 9,966 / 0 |

The baseline misses are physical requests **00107** (classifier r2, 288 ms after
the preceding response) and **00152** (JSONL r2, 20 ms). Native cached tokens were
zero; native cache-write tokens were 5,709 and 9,966 respectively. The classifier's
5,572-token derived rewrite excess is not identical to its 5,709-token miss write:
it is cumulative writes minus the largest context under the preregistered arithmetic.
Both misses occurred in repetition2, under opposite arm orders. Timing, provider
load and backend variation remain possible explanations; edge headers do not
identify the actual cache-routing backend. The treatment does not provide the
unobserved counterfactual for those exact two control conversations.

All six matched initial bodies were equal after excluding only independent cache
keys. Nevertheless classifier-r2-control reported 5,575 initial input / 5,572 write
tokens, versus 5,555 / 5,552 in the other classifier starts. This unexplained
20-token provider-reported variation is retained, not attributed to a changed
payload or silently normalized away.

## Capability and task-quality guardrails

Every clean run actually read the node-contracts skill and successfully ran the
public tests through native tools. The audit links requested commands to returned
exit0 results and all immutable named public cases, independently of runner flags.
All 12 runs used default sandbox execution; zero unsandboxed requests, sandbox
missing-dependency errors or approval denials were observed. Original seed files,
test instructions and skills remained unchanged. No sandbox or approval setting,
chore model, account or software installation was changed for this cohort.

Independent isolated artifact regrading reproduced control **5/6** and treatment
**4/6** frozen rubric passes, with **103/106 individual checks in each arm**. All
failed rubrics were classifier tasks. Keep the failed artifacts and charges;
public-test success does not prove full contract acceptance. This small sample
cannot establish quality equivalence or exhaustive capability preservation.
Delegation and all possible approval/tool paths were not exercised. Task completion
was a guardrail and reported outcome, not the efficiency optimization target.

## Exact experiment and independent verification

Live tested commit: `7d58e97cca77734c3595f824d54667ac19f84bcb`.
It preserves PR271 product source from `b1c2e4df329a371d2867f4224ba72ca83220e8a4`.
Build receipt and exact harness hashes are in the archive. The independent
prereview accepted the cumulative budget, guardrail and duplicate-refusal controls.
A fresh no-cost tool preflight matched that exact build before live dispatch.
The original 24-row ledger snapshot matched SHA256
`6b2c006cbf2358e5ab8c8961461c250b8c496574e71f161bf8740a84d1b00f22`.
No active coordinator or clean-r1 attempt existed before launch. A single physical
ledger and exclusive writer lock were used throughout; no paid attempt was retried.

Fixed contracts: same three synthetic tasks/seed files, scratch path, prompt/tool
surface, native OpenAI gpt-6-luna HTTP streaming, medium effort, 32K output cap,
previous_response_id chaining, store omitted, fresh independent conversation keys,
sandbox/approval configuration and existing socat PATH repair. Three pairs were
control-first and three treatment-first. Only treatment adds
`session-id=prompt_cache_key`; x-client-request-id was not added. Outgoing and
incoming body hashes match every request. All continuation chains and suppression
of repeated additional_tools, model, effort and output limits were independently
checked. Every retained raw request hash was also independently reconstructed from
its compact JSON; physical request intervals did not overlap. No replay-strategy or WebSocket change was mixed into this test.

The two offline analyses agree on all native counters and costs. Independent
verification also regraded all 12 artifacts and accepted observed tool capability,
transport and accounting evidence. It does not turn six stochastic pairs into a
strong causal estimate. No hosted-CI result is claimed. The preflight's four fake
exchanges and synthetic usage arithmetic are separately labeled and excluded from
all live counts and costs. No paid warm-up, hidden-grader feedback or paid grader.
No production source/default change, merge, deployment or account change occurred.

## Cumulative spend and next step

| Ledger component | Requests | Native-usage estimate |
| --- | ---: | ---: |
| Historical stopped cohort | 24 | $0.009997785 |
| Fresh clean-r1 cohort | 130 | $0.055383915 |
| Cumulative | 154 | **$0.065381700** |
| Uncertain exposure / pending requests | 0 | **$0** |

Provider invoices are unavailable; confirmed native usage is complete, while USD
amounts remain standard-rate estimates. Peak confirmed-rate estimate plus reserved
worst-case exposure was **$0.646897810**, below the cumulative $2 operational ceiling
and $100 TOTAL investigation cap. Estimated remaining investigation budget:
$99.934618300. The same $0.582 pre-dispatch reservation, concurrency 1, request/output
bounds and halt-on-uncertainty policy remained enforced. No further paid work is
running or scheduled by this experiment.

Retain the existing production defaults. The next evidence-backed step is a
separately reviewed fixed-trajectory native HTTP chain test that targets these
fast continuation misses while holding request count and tool-output sequence
fixed, or provider-side investigation of the retained request/routing IDs. It must
stay within the existing approved payload/destination and carry forward this
ledger. Do not extend this stochastic cohort until a desired significance or cost
result appears, or claim the write-excess arithmetic is proven recoverable savings.
No additional paid experiment was launched for that recommendation.

## Reproduce

Verify SHA256SUMS and extract clean-evidence.zip into an empty directory. It contains
all 154 native exchanges exactly once, all 15 historical+clean run outcomes (one
historical interrupted), their artifacts, original 24 ledger snapshot, final shared
ledger, protocol/build receipts, frozen harness and fresh preflight. Client state
and credentials are excluded; opaque encrypted reasoning is redacted. Check the
archive MANIFEST.json for each member's length/SHA256, then run:

```sh
python3 summarize-clean.py /path/to/extracted-evidence --cohort clean-r1
python3 clean-live-audit.py /path/to/extracted-evidence
```

Compare clean-summary.json and clean-live-audit.json; see clean-live-review.md and
clean-live-regrade.json for independent acceptance and artifact-quality limits.
