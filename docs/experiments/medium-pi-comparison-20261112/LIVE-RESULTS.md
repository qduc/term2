# Medium Term2 versus Pi — final live results

**Neither runner met the quality gate: 0 accepted outputs from 18 ended executions.**
Term2 used less money and observed execution time in the complete OpenAI cohort,
but this does not establish an efficiency win for completed useful work.
The study stopped at the approved $30 cumulative budget guard; no inference remains active.

The task is the historical built-in OpenRouter migration, selected from Git history:
base `c5f0002c3f086d3a7daf99c62fbcd5c6bbf6a3f8`, reference
`7b63338f042bbb3830a828e366abf8213ffe7d5c` (15 files, +494/−442 lines).
Both agents received the same full source snapshot, installed dependencies and
[task](task.md), without upstream solution history. Term2 Bare was unchanged
`d277aa0`; Pi was pinned 1.5.2. Application sandbox was **off**, with tools
**always approved**. Both used medium reasoning: **gpt-6-luna** on OpenAI and
**claude-haiku-5-5** on Anthropic. This compares runners, with no product patch.

## Outcomes and observed totals

Five repetitions per runner/provider were planned (20 executions). OpenAI completed
all five pairs. Anthropic ended four executions per runner: Term2 R1–R4, Pi R2–R5.
Pi R2–R4 reached the 20-minute limit; Pi R5 ended with a budget HTTP 402 despite
CLI exit code zero. Anthropic Term2 R5 and the deferred Pi R1 fresh retry never
started. The original Pi R1 was interrupted by environment loss; its charges remain.

Costs below include infrastructure retries attributable to ended cases. Times are
observed coding-agent execution minutes, excluding preparation and external grading.
Pi OpenAI R5's original interrupted wall time is unknown, so its complete case time
is censored. Anthropic Pi times describe truncated attempts, not completion times.

| Metric | OpenAI Term2 (n=5) | OpenAI Pi (n=5) | Anthropic Term2 (n=4) | Anthropic Pi (n=4, truncated) |
| --- | ---: | ---: | ---: | ---: |
| Accepted | 0/5 | 0/5 | 0/4 | 0/4 |
| Requests mean | 74.20 | 85.40 | 104.75 | 134.50 |
| Requests min–max | 67–86 | 67–110 | 93–113 | 120–154 |
| Requests sample SD | 7.89 | 17.31 | 9.18 | 15.61 |
| Cost mean | $0.084193 | $0.104407 | $1.444194 | $2.024065–$2.319065 bound |
| Known cost median | $0.079597 | $0.092099 | $1.472427 | $1.928768 known-only statistic |
| Known cost min–max | $0.073009–$0.097691 | $0.075636–$0.156096 | $1.202999–$1.628921 | $1.766550–$2.472174 known-only statistics |
| Known cost sample SD | $0.011237 | $0.031961 | $0.197402 | $0.335411 known-only statistic |
| Observed minutes mean | 10.25 | 11.50 | 14.07 | 18.94 |
| Observed minutes median | 10.89 | 11.37 | 13.40 | 20.00 |
| Observed minutes min–max | 6.67–14.04 | 7.95–18.55 | 11.78–17.69 | 15.75–20.00 |
| Observed minutes sample SD | 2.96 | 4.32 | 2.78 | 2.13 |

Anthropic Pi R4 includes one HTTP 404 `thread_not_found` without native usage.
Its known cost is $1.766550110, with a retained $1.18 reservation: the bounded
cost is $1.766550110–$2.946550110. Thus the Pi Anthropic cost distribution is
uncertain; its displayed point statistics describe only known-priced usage.
The incomplete, differently censored Anthropic cohorts do not support a clean
five-pair ranking. Full per-run data, paired differences, setup/total time spreads,
censor reasons and unstarted IDs are in archived `campaign-v3/summary.json`.

The complete OpenAI case-cost means differ by $0.020214 (Term2 lower); observed
execution means differ by 1.25 minutes (Term2 shorter). These are descriptive
results from one task and five pairs, with no medium-task A/A noise estimate or
claim of statistical significance. No run received external grader feedback or
an opportunity to repair its output after grading.

## Quality evidence

The historical reference passes TypeScript, 43/43 frozen HTTP contracts, 15/15
supplemental registry/HTTP/SSE checks, dependency and frozen offline lock checks,
architecture/complexity/rule guards and instruction integrity. The initial source
passes 42/43 HTTP and 9/15 supplemental checks, failing the overall gate. Those are controls, not live task
successes. The same frozen graders evaluated the actual saved agent edits.

Generated migrations repeatedly missed upstream error details and other adapter
contracts. String/null error-detail handling already passed in the starting source;
OpenAI outputs regressed those behaviors. Some outputs also violated complexity
or instruction-integrity gates. Behavioral failures independently reject every
output, so the zero acceptance result does not depend solely on strict policy gates.
TypeScript success alone did not establish task success. This is evidence about
agent-generated historical migrations, not a claim that current-main OpenRouter is broken.

Coding-agent inference was live. Acceptance checks used actual HTTP/SSE against
loopback fixtures and static gates, with frozen reference helpers and no credentials.
No live OpenRouter acceptance or hosted CI result is claimed. Four earlier real-CLI
loopback fixtures confirmed both runners could write scratch files with application
sandbox off and no approval prompt. Independent passive audit reconciles actual
native usage, prices, CLI records, source hashes and frozen grader inputs; it did
not rerun or repair agent solutions. Of 1,744 current-plan request bodies, 917
raw-body hashes reconstruct independently; 827 have documented signature/opaque
redactions, so original raw bytes cannot be reconstructed. Native usage remains
auditable. No successful candidate exists for qualitative
completion review. No optimization was accepted, and nothing was merged.

## Every completed OpenAI execution

| Rep | Runner | Requests | API cost | CLI minutes | HTTP | Supplemental | Accepted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | pi | 96 | $0.112860 | 11.37 | 43/43 | 10/15 | No |
| 1 | t2 | 68 | $0.094663 | 14.04 | 43/43 | 9/15 | No |
| 2 | pi | 78 | $0.085343 | 11.63 | 42/43 | 8/15 | No |
| 2 | t2 | 67 | $0.073009 | 6.67 | 42/43 | 11/15 | No |
| 3 | pi | 67 | $0.075636 | 8.00 | 43/43 | 11/15 | No |
| 3 | t2 | 72 | $0.076003 | 7.94 | 42/43 | 10/15 | No |
| 4 | pi | 110 | $0.156096 | 18.55 | 43/43 | 11/15 | No |
| 4 | t2 | 78 | $0.079597 | 10.89 | 42/43 | 10/15 | No |
| 5 | pi | 65 | $0.076329 | 7.95 | 42/43 | 11/15 | No |
| 5 | t2 | 86 | $0.097691 | 11.72 | 42/43 | 10/15 | No |

The execution table's Pi R5 cost excludes its separate interrupted attempt; the
case-level table above includes it. Interrupted attempt metadata, final partial
source, native usage, and recovery lineage are preserved. Completed observations
were never selectively rerun; only the environmentally interrupted case received
a fresh execution ID and workspace.

## Anthropic ended executions

| Rep | Runner | Requests | Known API cost | Observed minutes | Stop | Accepted |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | Term2 | 111 | $1.579688 | 14.80 | Normal | No |
| 2 | Term2 | 113 | $1.628921 | 17.69 | Normal | No |
| 2 | Pi | 154 | $2.472174 | 20.00 | Timeout | No |
| 3 | Term2 | 102 | $1.365166 | 12.00 | Normal | No |
| 3 | Pi | 120 | $1.767178 | 20.00 | Timeout | No |
| 4 | Term2 | 93 | $1.202999 | 11.78 | Normal | No |
| 4 | Pi | 124 | $1.766550 + $0–$1.18 uncertain | 20.00 | Timeout | No |
| 5 | Pi | 140 | $2.090358 | 15.75 | Budget error | No |

## Full accounting and stop reason

| Allocation | Known native-priced cost |
| --- | ---: |
| Current-plan executions (1,744 physical requests) | $14.800263775 |
| Two environment-interrupted originals (133 requests) | $2.231060365 |
| Full primary allocated cases | $17.031324140 |
| Exploratory 60-request pilots, excluded from comparison | $1.010820005 |
| Earlier campaign metered usage | $1.410903305 |
| **Cumulative known native-priced usage** | **$19.453047450** |
| Unresolved reserves (older $5.286 + initial proxy failures $2.91 + 404 $1.18) | **$9.376000000** |
| **Conservative cumulative exposure** | **$28.829047450 / $30** |

Primary cost is bounded at $17.031324140–$18.211324140 under the gateway's
reservation assumptions. Amounts apply frozen protocol prices to actual native
usage, including cache usage; they are not provider invoices. Unknown charges
were neither released nor treated as free. The shared cumulative ledger includes
all retries, failures and older work. Anthropic Pi R1's interrupted 122 requests
cost $2.215290930; OpenAI Pi R5's interrupted 11 cost $0.015769435.

The next send required $1.18 of headroom, but only $1.170952550 remained (the
launcher also requires a margin). The gateway refused to continue. The two
unstarted cases remain incomplete, not failures or zero-cost successes. Further
inference requires new budget authorization or authoritative settlement of
uncertain charges. No additional calls were made to obtain this report.

The initial parent gateway launch omitted `NODE_USE_ENV_PROXY=1`, producing five
transport failures and retained $2.91. The corrected launcher checks proxy routing.
Three exploratory pilots were excluded together after the old 60-request ceiling
truncated both Pi pilots; their combined $1.010820005 remains charged. The primary
protocol used 200 requests and 20 minutes per execution. Two environment losses
preserved completed results and partial source; only interrupted cases received
fresh IDs. One deferred Anthropic retry could not start. A later thread-state 404
retained its reservation; only unstarted cases resumed, with the same ledger and
rubric. Frozen executed producers, cap changes, interruption lineage and result
hashes are archived. These operational losses limit inference; they are not hidden
from the comparison's full costs.
