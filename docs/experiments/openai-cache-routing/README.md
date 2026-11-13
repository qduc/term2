# OpenAI cache-reuse diagnostic

This is an offline investigation, not a production optimization or a claim of
recoverable savings. Do not change default routing solely on these observations.

## Reproduce

Download `docs/experiments/live-efficiency-20261112/evidence.zip` from PR267 head
`3aa9ad78c822994593ec29bfb666b06d9f19b1d5`, then run:

```sh
python3 docs/experiments/openai-cache-routing/analyze.py /path/to/evidence.zip
```

The script verifies the frozen archive digest and reads JSON directly from ZIP,
without extraction or network calls. It intentionally rejects other archives.
Python 3.11 or later is required. Source and complete experiment limitations:
[PR267](https://github.com/qduc/term2/pull/267).

## What the retained traces establish

Across six matched current-main Luna task runs per runner:

| Diagnostic | Term2 | Pi |
| --- | ---: | ---: |
| Requests | 69 | 71 |
| Cache-write tokens | 143,937 | 57,349 |
| Initial-request cache writes | 32,758 | 10,346 |
| Cumulative writes minus largest per-run cached+written context | 64,205 | 0 |

The 64,205-token difference is 74.15% of the total 86,588-token write gap.
This arithmetic identifies repeated cache writing relative to each run's largest
context, **not** a counterfactual savings estimate. Distinct model trajectories
and cache implementations remain confounders. Initial writes explain another
22,412 tokens; tokenized initial input is about 3,735 tokens larger for Term2.

Every Term2 run contains one continuation with zero cache reads. The six request
IDs are `00204`, `00260`, `00285`, `00334`, `00354`, and `00403`; they start
21–278 milliseconds after the previous response completes. Later requests may
reuse shorter prefixes rather than the immediately preceding context. Cache keys
remain stable. The prior independent audit verified immediate-predecessor
response chaining and omission of repeated additional-tools declarations.

Pi has no `previous_response_id` and uses `store:false` on all 71 requests.
Term2 chains all 63 continuations and omits `store`. Thus replay strategy is a
material confounder, not evidence that chaining itself is defective.

## Routing hypothesis and no-cost control

Pinned `@earendil-works/pi-ai` 1.5.2, `dist/api/openai-responses.js`, supplies
`session-id` and `x-client-request-id` alongside the body cache key. Term2's native
OpenAI constructor at `753432c4ae39e73224ee004f659d6cc95e039331` does not add these
default headers. The frozen gateway forwards them but did not retain request
headers. These are source-level observations, not reconstructed live headers.

A temporary integration control used the real native OpenAI provider registry,
SDK and loopback HTTP fixture, alternating baseline, explicit `Session-Id`, and
baseline. Only the treatment request carried the header; all three request
bodies were equal and caller options were not mutated. The existing nine
provider-affinity integration cases also passed. This demonstrates the existing
`providerOptions.extraHeaders` path is adequate for a controlled HTTP experiment;
it does not test upstream cache behavior.

Do not inject headers in the generic mapper as an assumed fix: the WebSocket
pool keys sockets on `session-id`, so doing so would change socket reuse as well
as HTTP routing. Do not copy stable `x-client-request-id` merely for parity:
it is a request-diagnostics identity, not established cache affinity. Native
OpenAI's `session-id` cache effect has not been established by this investigation.

## Smallest causal experiment

Keep the Term2 build, model, task, tools, prompts, effort, output limit, transport
(HTTP), chaining, approval and sandbox behavior fixed. Vary only explicit
`session-id`, using the same non-secret conversation identity already present in
the cache key. Alternate arm order, use independent conversation/cache keys per
run, and retain failed attempts and all usage. Do not remove capabilities or
switch replay strategy at the same time.

Capture an allowlist of routing-header values (never credentials), request/body
hashes, native usage, request timing, tool errors and retained capability checks.
Reconcile actual plus uncertain exposure in one durable budget ledger before
every physical request. Default to no inference; a paid run requires current
user authorization and an enforceable spending ceiling. Missing usage keeps its
reservation and stops the experiment. No paid run was performed for this note.

If the header alone consistently reduces rewrite excess without changing the
other contracts, consider an HTTP-only production change with explicit-header
precedence, header-value validation, no ambient-identity leakage, and independent
verification. Otherwise retain the negative result and test replay/cache semantics
separately. Task completion is a guardrail here, not the efficiency objective.
