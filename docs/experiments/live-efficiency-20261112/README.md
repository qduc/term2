# Term2 / Pi live quality and API-cost comparison

**The same-or-lower-cost goal remains unmet in this sample.** On current main,
Term2 and Pi each passed **11/12** frozen rubrics. Term2 cost **$0.093413645**;
Pi cost **$0.070037710**: Term2 was **33.4% more expensive**.
Term2 passed 209/212 individual checks versus Pi’s 210/212; equal rubric totals
do not establish equivalent quality.
All costs include failed tasks and natural repairs. No paid grader or feedback-driven
repair was added.

| Current-main provider | Term2 rubric passes / cost | Pi rubric passes / cost |
| --- | --- | --- |
| OpenAI Luna | 5/6 / $0.038867965 | 5/6 / $0.026724635 |
| Anthropic Haiku | 6/6 / $0.054545680 | 6/6 / $0.043313075 |
| Total | 11/12 / $0.093413645 | 11/12 / $0.070037710 |

The follow-up has **24 live runs / 216 native requests**. Across both cohorts,
**48 runs / 416 requests** cost **$0.320432550**, all with reconciled
native usage and artifact hashes. The earlier uncaptured setup request reported
$0.000176925, making known/reported usage $0.320609475; setup cannot be fully
reconciled to native captures or invoices. Keeping its full **$5.286 conservative
reserve**, total exposure is **$5.606432550**, below the
approved **$10** total cap. Both coordinators are closed and paid work stopped.


The frozen checks cover three constructed Node coding tasks, two repetitions per
provider/runner. They do not establish general quality equivalence, long-horizon
reliability, or delegation quality. Capabilities remained available, but these
tasks did not require every capability. Costs use captured native usage at
verified published rates; provider invoices were not available.

On current main, Term2 sent fewer OpenAI requests (69 versus 71) but still cost
45.4% more on that provider. Cache writes account for about **89.1% of its OpenAI
cost gap**, cache reads 7.7%, and output 3.2%, with a tiny fresh-input offset.
Anthropic’s gap is about 38.7% cache reads, 26.8% cache writes and 34.5% output.
These decompose native usage costs at published rates; they do not prove which prompt
or tool change would reduce costs without losing task quality. The old hypothesis
that extra OpenAI output explains most of the gap is unsupported in both cohorts.
The current static-tool cache marker is present, but initial cache hits remain
uneven; no causal cache-policy ablation was run.

## Current-main cohort and evidence boundary

The current-main cohort measures Term2 production source
`da42e92a33e3c7ec1762fb9a10b23fac68839969` against pinned Pi 1.5.2. It includes
PR263 (Anthropic static-tool cache breakpoint), PR265 (array guidance), and PR266
(single retry owner). The build receipt names `ed4ad68e9b15e3038d209c8cf6f9c27926fbae56`,
which adds historical evidence atop that source. `assertFreshBuild` verified exact
input and emitted-output digests before the cohort. No production bundle changed
within either cohort.

The follow-up was added because the first investigation missed the already-open
PR263, which merged during the historical campaign. The historical cohort remains
published below and in the archive. This was one fixed 24-run refresh, using the
same tasks, graders, runner order, effort, output limits, Pi version and physical
budget ledger. Only cohort IDs and measured-source metadata changed in the harness.
We stopped after the two declared cohorts, including all failures. Several source
changes and fresh stochastic model outputs separate them; the difference cannot
be attributed to PR263 or any single change.

Deliverables: [current summary](current-main-summary.json),
[historical summary](summary.json), [cohort comparison](comparison.json),
[current independent review](current-main-independent-review.md),
[historical review](independent-review.md), [combined evidence](evidence.zip),
and [checksum](evidence.zip.sha256). The archive contains both frozen harnesses,
source/build identities, native exchanges, initial/final task files and CLI traces.
Historical metadata/runtime/ledger are under `historical/`; shared immutable
native exchanges and the final full ledger are under `wire-live/`; current run
artifacts are under `runs/`. Fixtures are kept under `preflights/` and are excluded
from live counts/costs. The original historical archive SHA256 is
`bbc53852c36656d4e76260877298adc8f14e02c75431814fdb136595f0b66438`, retained on
branch `codex/live-efficiency-comparison` at `9d17db998bcccb7a75f0937b74a073c37ee8c4e9`.

The current-main invocation was:

```bash
BENCH_LIVE_APPROVED_CAP_USD=10 BENCH_COHORT_TAG=current-main BENCH_MEASURED_SOURCE_COMMIT=da42e92a33e3c7ec1762fb9a10b23fac68839969 BENCH_ROOT=/workspace/term2/.worktrees/cache-lookback/.handoff/current-main-campaign NODE_USE_ENV_PROXY=1 node docs/experiments/live-efficiency-20261112/run-comparison.mjs --live
```

`current-main-campaign/wire-live` resolves to the original `live-campaign/wire-live`
directory, retaining every earlier charge and the $5.286 external exposure bound.
Do not replace it with a fresh ledger. To re-aggregate existing evidence without
any inference, run `summarize.mjs` on each campaign root and
`compare-cohorts.mjs <historical-summary> <current-summary>`. To export settled
evidence, run `archive-evidence.py <current-root> <output.zip> <original-historical.zip>`.
The exporter rejects an active coordinator, changed artifact/native hashes, and
potential credentials. Runtime client state and auth files are excluded.

## Historical source cohort (66dda24da)


**The quality/cost goal was not met in this sample.** Across the 24 live coding
runs, Term2 passed 9/12 frozen rubrics and cost $0.096294990; Pi passed 10/12 and
cost $0.060686205. Term2 cost **58.7% more**, including the failed tasks. No extra
model rework was launched to improve these scores.

| Provider | Term2: rubric passes / API cost | Pi: rubric passes / API cost |
| --- | --- | --- |
| OpenAI Luna | 4/6 / $0.034336785 | 5/6 / $0.019238250 |
| Anthropic Haiku | 5/6 / $0.061958205 | 5/6 / $0.041447955 |
| Total | 9/12 / $0.096294990 | 10/12 / $0.060686205 |

All **200 comparison requests** have native usage, reconciled accounting and
retained artifacts. All returned HTTP200; five coding attempts still failed
their acceptance rubric. Pagination and JSONL passed their frozen checks in every
run. The first classifier repetition failed on both runners/providers; the second
passed except for Term2/OpenAI. Rubric passes are not exhaustive correctness:
the independent supplementary audit found additional defects described below.

Captured comparison cost is **$0.156981195 total**. With the earlier uncaptured
preflight's conservative $5.286 reserve retained, exposure is **$5.442981195**,
below the approved $10 cap. The historical coordinator closed after its predeclared 24 runs.
A separately pinned current-main cohort was then added as described above. This is a live-inference study on constructed coding
repositories, not a claim about all production work.

This historical cohort compares source-built Term2 at `66dda24da` with
`@earendil-works/pi-coding-agent@1.5.2` on three small Node.js coding tasks.
The approved spending limit is **US$10 total across OpenAI and Anthropic**.
It does not authorize a merge, release, deployment or account change.

The local bundle was built before the implementation commit. Its production
input digest and emitted-output digest still match the retained build receipt;
the receipt's HEAD metadata names the pre-commit base. `build-identity.json` in
the archive makes this distinction explicit. No bundle was rebuilt during the
campaign. Runtime lockfiles and the exact frozen harness are retained.

Results, per-run checks and native-usage totals are recorded in `summary.json`.
The evidence archive retains the prompts, initial files, final source artifacts,
CLI event streams, sanitized native exchanges, ledger and frozen harness.
Failed tasks and all captured requests remain included. Fixture exchanges are
separate from live comparisons and are not priced as paid inference.

Deliverables: [full summary](summary.json), [independent review](independent-review.md),
[evidence ZIP](evidence.zip), and [archive checksum](evidence.zip.sha256).

## Frozen comparison

The primary protocol has 24 runs: pagination, error classification/retry handling,
and a streaming JSONL report; two repetitions; Term2 and Pi; both providers.
Runner order alternates by task and reverses on the second repetition. Every
attempt starts a fresh client/session and identical task files. This does not
guarantee a cold provider cache; native cache reads/writes are retained.

The paired models are native OpenAI `gpt-6-luna` and native Anthropic
`claude-haiku-5-5`. Both runners request medium effort and at most 32,000 output
tokens. Pi's Anthropic adapter preserves a low top-level cached-prefix effort and
sets the effective reply effort to medium in a system-message marker; this is
its native protocol, not a lower comparison effort.

Both runners receive the same `AGENTS.md`, task prompt, `node-contracts` skill,
public tests, and hidden acceptance rubric. Workspaces live outside the Term2
checkout so Pi cannot inherit its ancestor instructions. The measured rubric
contains 14 pagination, 26 classifier and 13 JSONL checks. A pass also requires
successful CLI/public-test completion and unchanged instructions/tests/skills.
There is no fresh model rework or grader feedback. Natural repairs and retries
inside a run are part of its full usage and cost.

Term2 uses its shipped default Bare profile with its tools, skills, delegation,
approvals and sandbox retained. Pi uses its shipped default tools/extensions and
project trust for these owned scratch repositories. These are different tool
surfaces, not an assertion that the runners have identical capabilities. Term2's
normal HTTP transport is selected so both native HTTP exchanges can be metered.
Neither system prompt nor tool schema is shortened for this comparison.

## Budget and measurement boundary

`budget-gateway.mjs` exposes a loopback HTTP gateway and durable ledger. Native
SDK endpoint configuration routes requests through it: Term2's OpenAI SDK
`OPENAI_BASE_URL`, Term2's Anthropic provider URL, and Pi's documented provider
`models.json` URL overrides. Native provider IDs and model metadata remain intact.
Pi's native Anthropic message-thread capability is explicitly retained behind
the transparent gateway. Request bodies and response continuation/retry headers
are forwarded; HTTP framing/encoding headers are reconstructed after decoding.
Only the gateway process receives configured provider credentials. They are not
written into task repositories or evidence.

Before every physical send, the gateway synchronously persists a maximum-charge
reservation. The bounds include full chained context absent from the current
POST: 1.1 million input tokens at the highest allowed cache-write price, plus
32,000 output tokens. Reservations are $0.582 for Luna and $1.18 for Haiku.
The gateway rejects other models, larger/unbounded output, paid hosted tools,
nonstandard service tiers, fast mode and regional price modifiers. An exclusive
directory lock prevents duplicate coordinators from admitting against stale
ledgers. The lock remains held until pending upstream handlers settle. A stale
lock fails closed; never remove it or discard a reservation merely to resume.

Completed native usage replaces a reservation with its published-rate cost.
Missing/incomplete usage retains the maximum reservation and stops new campaign
work. Admission includes all prior retained exposure and a one-cent margin.
The guard applies to the configured benchmark clients; it is not an account-wide
billing limit for unrelated activity.

Cost arithmetic uses native input/output/cache counters and whole-request context
tiers, including cache creation and one-hour Anthropic writes. Reasoning tokens
are already included in output and are not charged twice. The principal sources
are [OpenAI's Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing), and
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
These are **captured-usage costs at verified published rates, not provider
invoices**. Term2's displayed per-dimension micro-dollar rounding can differ
slightly; it is not the comparison's pricing denominator.

## Preflight incident and retained exposure

The rejected first interceptor wrapped global `fetch`. Pi replaces it during HTTP
dispatcher startup. An intended free Pi/OpenAI preflight escaped that interceptor
and completed one live request; Pi reported input 3, cache-write 1,381 and output
8 tokens, costing $0.000176925 at catalog rates. The Pi/Anthropic preflight returned
an invalid-key HTTP401 error. Their raw provider exchanges were not captured.
Both CLI streams are retained; neither is passed off as a fixture or a measured
coding-task run.

Provider work stopped on discovery. The campaign's same durable live ledger holds
**$5.286 conservative external exposure**, representing three maximum physical
charges for each provider. This remains counted against the $10 cap throughout
the campaign. It is a safety bound, not a claim that $5.286 was spent. The reported
small OpenAI charge is not added on top of that upper bound. The uncaptured
preflight prevents a fully reconciled invoice-style total for setup activity.

The historical first-preflight result files retain their erroneous `fixture`
flag for audit; the live ledger and this report classify the escaped activity
as uncaptured live preflight work.

Documented endpoint overrides replaced the interceptor. Corrected free preflights
required exactly one captured, metered completion in each of the four native
runner/provider arms. The real Term2 sandbox wrapper separately executed
`node --version` successfully. Nested command-tool sandboxing prevented its UID
map setup, so these runs execute outside that outer command sandbox while retaining
Term2's own sandbox. Socat and its library were unpacked locally; no sandbox,
approval policy, account or credential configuration was weakened.

## Verification and reproducibility

An independent verifier accepted the guard before the coding campaign. Free
controls cover concurrent admission, restart retention, duplicate writers, disk
reservation before send, price modifiers, hosted tools, continuation/retry
headers, and a disconnected downstream with a pending upstream handler.
Independent reference implementations pass all three rubrics; default-page-limit,
quota-handling and sorting mutants fail. Hidden grading runs in a bounded,
credential-scrubbed child with network/PID isolation; infinite loops time out.
These controls establish the measurement method, not live task quality or Pi parity.

The final independent audit reconciled all 24 runs and 200 requests, regraded all
artifacts, and confirmed actual skill reads and successful public-test tool
execution in all 24 native traces. It accepted the scoped measurements while
rejecting an overall quality/cost success claim.

The source interfaces are `BudgetGateway.start/register/close`,
`prepareWorkload(name,directory)`, and the isolated
`gradeWorkload(name,directory)`. `run-comparison.mjs` orchestrates the fixed plan;
`summarize.mjs` joins native requests to outcomes and checks artifact hashes.
The frozen source ZIP and hashes identify the actual measurement implementation.
Later lint-only source annotations do not replace that frozen evidence.

The recorded launch used the existing cloud credentials without printing them:

```bash
BENCH_LIVE_APPROVED_CAP_USD=10 BENCH_ROOT=/workspace/term2/.worktrees/cache-lookback/.handoff/live-campaign NODE_USE_ENV_PROXY=1 node docs/experiments/live-efficiency-20261112/run-comparison.mjs --live
```

Reproduction requires a new explicit spending authorization, the pinned Pi
installation, Node 24, a source-built Term2, working bwrap/socat, and the same
task/setting protocol. For this campaign, do not replace its ledger with a fresh
root: that would discard the preflight exposure. `--only=<planned-run-id>` resumes
a specific uncompleted plan entry; completed result files are never overwritten.

The findings are descriptive evidence from three small tasks and two repetitions,
not a universal model ranking or a statistical quality-equivalence guarantee.

## What the measurements explain

The first pagination requests devote about 84.3% (Luna) and 84.6% (Haiku) of
Term2's request bytes to serialized tool arrays, versus 36.4% and 38.3% for Pi.
These are measured byte shares in this cohort, not a reconstruction of the lost
earlier archive or an equivalence between bytes and tokens. Term2 exposes more
capabilities, including delegation and the `run_code` catalogue, throughout.

Across the full cohort, Term2 sent 550,578 total input tokens on OpenAI versus
Pi's 219,642, and 956,490 on Anthropic versus 272,680. Cache reads and writes are
included. The charged differences must be decomposed rather than priced as if
all input were uncached: roughly 74% of the OpenAI cost gap is cache writes,
16% cache reads and 10% output; Anthropic's gap is about 39% writes, 30% reads
and 31% output. Tiny uncached-input differences make up the remainder.

The historical lead that extra OpenAI output drove most of the gap was not
reproduced here. A pilot audit found correct Luna previous-response chaining,
not unnecessary full-history replay. One zero-read/cache-write continuation was
observed, but its cause is unproven. No causal ablation establishes how much a
smaller catalogue or different caching policy would save while preserving quality.

Fresh sessions were not uniformly cold caches. Five of six Anthropic/Pi initial
requests read 1,310 cached tokens; Term2's initial requests read zero. Pi marks
the last initial tool as a cache breakpoint; Term2 marks system/user messages
but not tools in this historical source. **PR263 already implemented a static-tool
breakpoint and merged during this campaign.** The initial investigation missed
that open PR; the current-main follow-up includes it rather than duplicating it.
Even replacing those five
Pi hits with cold five-minute writes adds only $0.00075325 and does not reverse
the observed cost comparison.

[PR266](https://github.com/qduc/term2/pull/266) fixes hidden retry ownership and
its CI passed. This live cohort contains no failed HTTP attempts, so it does not
demonstrate live dollar savings from that fix. Its retry reduction remains
fixture evidence. [PR265](https://github.com/qduc/term2/pull/265) is separate and
is absent from the historical pin and present in the current-main follow-up.
PR263, PR265 and PR266 are all included in the current-main source; differences
between cohorts do not isolate any one PR or prove its causal savings.

## Quality limits and supplementary checks

Independent inspection confirmed real classifier defects, including negative
Retry-After values being misread as dates, missing numeric HTTP-status prefixes,
and incomplete unknown-error handling. Supplementary checks beyond the frozen
rubric also found a 150,000-item page overflowing one Term2/OpenAI artifact and
overly strict large-revision handling in both first-repetition Anthropic JSONL
artifacts. These are preserved as findings rather than retroactively changing
the frozen rubric or supplying feedback for paid repairs. See the
[independent review](independent-review.md) and per-artifact results in the archive
for exact coverage and locators.

Local loopback/guard/rubric checks, the measured production source's passing CI,
and these live model outcomes are separate evidence. Grading used local checks,
with no additional model-judge requests on the configured provider keys. No merge,
release, deployment or account change was performed by this investigation.
Maintainers merged the cited source PRs independently.
