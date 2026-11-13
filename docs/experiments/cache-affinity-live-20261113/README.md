# Controlled HTTP Session-Id experiment

Preregistered before paid calls, 2026-11-13. PR271 head verified at
`b1c2e4df329a371d2867f4224ba72ca83220e8a4`; production source is unchanged.
Read the parent [protocol](../openai-cache-routing/README.md).

Six matched pairs: pagination, classifier, JSONL, each twice. Alternate arm order
within task/repetition (AB/BA); sequential runs, no warm-up or additional campaign.
Each run gets fresh application state and conversation/cache key, the same scratch
workspace path, frozen task inputs, shipped tool/prompt surface, HTTP, medium effort,
32,000 output ceiling, sandbox enabled and auto-approval for owned scratch tasks.
Natural within-run repairs count; no hidden-grader feedback or paid grader.
Capability is a guardrail, not the optimized outcome.

The transparent relay forwards native Term2 request bytes unchanged. Treatment adds
only `session-id` equal to the existing `prompt_cache_key`; baseline adds nothing.
No stable x-client-request-id intervention, store change, replay change, WebSocket,
production default, account change, merge or deployment. This tests the header's
upstream effect, not a proposed product integration of extraHeaders.
Allowlisted incoming/outgoing routing headers, raw-body hashes, native SSE counters,
request timing and provider request IDs are retained. Credentials and encrypted
reasoning payloads are excluded/redacted. Independent task trajectories remain a
limitation; initial wire bodies are compared after removing independent keys.

Budget authority: $100 TOTAL; starting confirmed/estimated/uncertain spend $0.
Operational ceiling $2 with $0.01 safety margin; one upstream request at a time,
max 20/run and 240 total, output <=32,000. Before every physical request the
exclusive-writer ledger atomically reserves $0.582, conservatively covering 1.1M
long-context input at the most expensive 12h write tier plus maximum output.
Missing usage or non-200 halts further requests, including on resumed ledgers.
No ambiguous billed request is retried. Metered usage replaces the reservation;
provider invoice-confirmed spend remains unavailable. This ceiling bounds this
campaign beneath the $100 investigation cap even if task trajectories differ.

Price source checked 2026-11-13: https://developers.openai.com/api/docs/models/gpt-6-luna
and https://developers.openai.com/api/docs/pricing . Short-context USD/million:
fresh input 0.10, cached input 0.01, 30m cache-write 0.125, output 0.50;
long-context/extended-retention pricing is handled conservatively by the meter.
These are estimates from native usage, not provider invoices.

Frozen workloads/grader derive byte-for-byte from commit
`3aa9ad78c822994593ec29bfb666b06d9f19b1d5`; runner/meter are adapted here.
Build provenance is checked and retained. Fixtures are separate from live usage.
No hosted CI is being claimed. Reproduce fixtures (no paid calls):

```sh
BENCH_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/fixtures-new NODE_USE_ENV_PROXY=1 node docs/experiments/cache-affinity-live-20261113/run-comparison.mjs
```

Run the bounded authorized campaign (requires configured credential):

```sh
BENCH_LIVE_APPROVED_CAP_USD=100 BENCH_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/cache-affinity-live NODE_USE_ENV_PROXY=1 node docs/experiments/cache-affinity-live-20261113/run-comparison.mjs --live
```

Stop after the fixed cohort, a meaningful failure, missing usage, or budget refusal.
Compare total cost, tokens, request counts and latency; cache-read/cache-write
counters are native. Writes minus the largest cached+written context is derived
arithmetic, not proven recoverable savings. Report per-pair direction and noisy
trajectory differences; six pairs cannot establish broad equivalence. Preserve all
failed attempts, checks and charges. Do not extend based on a disappointing result.
