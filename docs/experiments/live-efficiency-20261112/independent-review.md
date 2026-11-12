Independent live-measurement review: accept the scoped evidence and reject a claim that the overall efficiency goal was met.

All 24 frozen runs and 200 native HTTP requests were independently audited. Native response usage was parsed separately from the gateway ledger and priced with integer nanodollar arithmetic. All request IDs, completed-response counts, CLI usage and candidate-file hashes reconciled. Pi's finalized cost values match the independently priced usage. All 119 Term2 cost records match its documented per-dimension micro-dollar rounding; small differences from unrounded native-price totals are rounding, not missing cache writes.

| Provider | Runner | Frozen rubric passes | Requests | Native-usage price estimate |
| --- | --- | ---: | ---: | ---: |
| OpenAI | Term2 | 4/6 | 66 | $0.034336785 |
| OpenAI | Pi | 5/6 | 49 | $0.019238250 |
| Anthropic | Term2 | 5/6 | 53 | $0.061958205 |
| Anthropic | Pi | 5/6 | 32 | $0.041447955 |

Term2 passes 9/12 frozen task runs versus Pi's 10/12, at $0.096294990 versus $0.060686205 (58.6769% higher estimated cost). Failed-quality runs remain included. All 200 measured HTTP responses completed successfully; no paid failed-HTTP retry was observed. Therefore the earlier retry-ownership fix has deterministic/fixture evidence but no demonstrated causal savings in this live cohort.

Total metered comparison estimate is $0.156981195. The same campaign ledger retains $5.286 conservative exposure for the earlier uncaptured preflight incident, yielding $5.442981195 total budget exposure, below $10. The retained amount is an upper bound, not an assertion that $5.286 was actually charged. These estimates are not provider invoices.

Cost decomposition:
- OpenAI Term2-minus-Pi difference is $0.015098535: cache writes $0.011222375 (74.3%), cache reads $0.002411060 (16.0%), output $0.001460000 (9.7%), fresh input $0.000005100.
- Anthropic difference is $0.020510250: cache writes $0.007967250 (38.8%), cache reads $0.006200300 (30.2%), output $0.006338500 (30.9%), fresh input $0.000004200. Thus approximately 69% of this gap is charged input dimensions and 31% output.
- All 60 Term2 Luna continuations reference the immediately preceding response and omit repeated additional_tools declarations. No unnecessary full-history reset was observed there. Six continuations, one in each Term2 Luna run, report zero cache reads despite the intact chain. Their cause is not established; those costs are retained.

Conditions and cache qualification:
The study uses three bounded Node.js repair workloads, two repetitions, native gpt-6-luna and claude-haiku-5-5, medium reasoning, a 32K output ceiling, HTTP transport and the retained shipped CLI capabilities. In all 24 runs, actual native tool-call inputs request the node-contracts skill read and public-test execution. Matching tool-result IDs return the skill's distinctive instruction text and at least one passing public-test TAP summary. This distinguishes observed agent execution from the separate external public-test result. Term2's real sandbox smoke passed; isolated graders retained network/PID isolation. This study does not exercise every delegation, approval or sandbox journey.

Fresh conversations were not uniformly cold provider caches. Five of six Anthropic Pi first requests read 1,310 cached tokens; Term2's first requests read zero. Actual Pi requests mark a stable tool-definition cache breakpoint while Term2's initial requests mark system/user content only. The maximum standard-rate benefit of those five reads relative to five-minute writes is $0.000753250, which does not reverse the result. This is a future cache-strategy lead, not a measured Term2 improvement.

Quality verification:
All 24 artifacts were regraded under actual bwrap isolation and reproduced the frozen rubric scores. Additional requirements-oriented controls were applied identically across runners without changing the frozen rubric or feeding repairs to the models. These supplemental checks found:
- OpenAI pagination r2 Term2: a valid single page containing 150,000 items throws a call-stack RangeError. The other seven pagination artifacts pass this check.
- All four Anthropic JSONL artifacts: revision 1e20 is rejected even though the contract requires a nonnegative integer revision and explicitly reserves the safe-integer restriction for amountCents.
- OpenAI classifier r1 Term2 and r2 Pi: {status:418, code:'ECONNRESET'} fails the contract's network fallback after unrecognized HTTP statuses. One of these artifacts already fails the frozen rubric; the other passes it.

These counterexamples remain separate from the preregistered pass counts. They show why rubric success is not exhaustive completed-task acceptance. An array-page-object diagnostic was also recorded without score impact because the original pagination contract does not explicitly exclude arrays carrying an items property.

Durable evidence:
- live-audit.mjs and live-audit-results.json: all 24 native/CLI/hash reconciliations and per-request dimensions.
- final-decomposition.json: group totals and independently computed cost components.
- chain-and-rounding.json: continuation and exact rounding checks.
- artifact-grade-rerun.mjs, pagination-extra.mjs, extra-contracts.mjs and all-artifact-verification.json: isolated regrading and supplementary counterexamples.
- instruction-compliance.mjs, tool-result-compliance.mjs and their JSON outputs: native skill/test requests matched to returned tool evidence in all 24 runs.
- post-run-source-comparison.json: current harness versus the frozen archive has identical esbuild-normalized executable output for all four scripts. Textual changes were reviewed as lint-global declarations and empty-catch comments only. The original frozen archive and hashes remain the measurement authority.

No inference calls, candidate source edits or repair feedback were made by the verifier. Scope acceptance is limited to the measured conditions; it does not establish general Pi parity, release acceptance, provider billing totals beyond the retained bounds, or achievement of the original quality/cost goal.
