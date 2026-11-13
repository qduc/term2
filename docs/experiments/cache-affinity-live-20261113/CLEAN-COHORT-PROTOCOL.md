# Fresh balanced cohort clean-r1

Preregistered before new paid inference on 2026-11-13. Original paid cohort remains
historical and inconclusive. Its 24 requests and $0.009997785 estimate, with $0
uncertain exposure, remain in the one cumulative physical ledger. Initial ledger
SHA256: `6b2c006cbf2358e5ab8c8961461c250b8c496574e71f161bf8740a84d1b00f22`.
No active coordinator/lock or clean-r1 request existed at preparation. Shared wire
storage is reused, not reset; starting-ledger.json retains the exact 24 entries.

## Fixed design

Same three frozen synthetic tasks (pagination, classifier, JSONL), twice each,
with baseline and affinity arm per task/repetition: 12 runs / six matched pairs.
Order is fixed and balanced, three baseline-first and three affinity-first:

| Pair | Order |
| --- | --- |
| pagination r1 | baseline, affinity |
| classifier r1 | affinity, baseline |
| jsonl r1 | baseline, affinity |
| pagination r2 | affinity, baseline |
| classifier r2 | baseline, affinity |
| jsonl r2 | affinity, baseline |

Fresh unique run IDs carry clean-r1; fresh independent conversation/cache keys.
Use the same scratch path, seeded files, prompt, tools, shipped bare profile,
Luna native HTTP streaming, medium effort, 32K output cap, previous_response_id
chaining and omitted store. No x-client-request-id intervention, replay change,
helper-model configuration, approval/sandbox policy change, paid warm-up, paid
grading, hidden-test feedback, network task or unrelated inference. Both arms
prepend the saved environment's existing /workspace/.local/usr/bin to PATH. Only
affinity adds Session-Id equal to the already-present prompt_cache_key at the
relay. Preserve raw-body hashes and allowlisted outgoing headers/native counters.

## Preconditions and stops

Build and verify exact provenance. Run the no-cost loopback tool preflight against
that build: skill read, source edit, actual public tests, default sandbox, no
unsandboxed calls or security-setting change. Live startup requires its passing
result and matching build receipt, as well as the original 24-entry ledger prefix
and initial snapshot digest. Existing unfinished run IDs are never rerun blindly.

The $2 operational ceiling covers the **whole cumulative ledger**, inside Duc's
$100 TOTAL cap. Concurrency1; max20 requests per run, max240 physical ledger rows
including earlier requests; output <=32,000. Reserve $0.582 atomically before
every physical upstream call; use the same conservative long-context/extended
write bound and verified published native rates. Missing usage retains reservation
and halts same-process and restarted dispatch. No ambiguous billed retry. Standard
native endpoint only: https://api.openai.com/v1/responses, with already-configured
credential and previously approved synthetic tasks, prompts/tool definitions and
tool/test outputs. No account or destination changes.

Stop further paid dispatch when tool results report a sandbox/approval failure or
native response requests an unsandboxed shell command. The response stop operates
after response capture; it prevents later billed requests, not the CLI receiving
the just-streamed tool request. Normal application approval policy remains intact.
Retain the triggering response and any resulting tool effects. Persist stop markers
across restart. Stop after a run if actual skill read/public-test success is absent,
unsandboxed calls occur or task instruction/seed files change without authorization.
Public-test observation requires a real returned shell result for node/npm/pnpm,
exit0/pass/fail0 and all original public case names. Natural test failures and
within-run repairs count; external rubric results remain capability/quality evidence,
not the optimization target. No automatic extra rounds after the fixed cohort.

## Analysis and claim limits

Separate clean-r1 from all historical attempts in comparisons; retain all in spend.
Report arm and per-pair request counts, native input/read/write/output, derived
fresh input and writes-minus-largest-context, initial cache state, HTTP/child
latencies, exact native-rate costs and observed tool/quality outcomes. Verify matched
initial bodies after excluding only independent keys. Reparse native terminal
usage independently with integer nanodollars. Include failures without replacing
runs, report direction consistency and paired variation, and do not interpret
rewrite excess as proven recoverable savings. Six pairs of stochastic coding tasks
cannot establish equivalence or undocumented affinity semantics. Fresh keys do not
guarantee cold shared provider caches. Header-effect causality requires consistency
beyond unrelated trajectory/request differences; zero baseline misses leave no
observed symptom to fix. No production change follows automatically.

## Invocation

After build and successful tool preflight at a new root, use the existing shared
wire ledger in .handoff/cache-affinity-clean-r1/wire-live:

```sh
BENCH_LIVE_APPROVED_CAP_USD=100 BENCH_COHORT_TAG=clean-r1 BENCH_PRIOR_LEDGER_SHA256=6b2c006cbf2358e5ab8c8961461c250b8c496574e71f161bf8740a84d1b00f22 BENCH_PREFLIGHT_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/cache-affinity-clean-r1-preflight BENCH_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/cache-affinity-clean-r1 NODE_USE_ENV_PROXY=1 node docs/experiments/cache-affinity-live-20261113/run-comparison.mjs --live
```

Do not rerun a stopped cohort. No new inference was made to write this protocol.
