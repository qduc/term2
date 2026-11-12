Independent current-main review: accept the scoped measurements. The same-or-lower-cost goal is not met in this cohort.

Source and separation:
This cohort measures production source da42e92a33e3c7ec1762fb9a10b23fac68839969, including already-merged PR263/265/266. Receipt HEAD ed4ad adds historical evidence only; product source/package/lock match da42 and the saved fresh-build receipt identifies the measured bundle. The earlier 66dda cohort remains historical evidence and is not substituted for current-main performance. No new optimization was implemented by this measurement refresh, and this is not a causal ablation of PR263.

All 24 current-main live runs and 216 native HTTP requests were independently audited after the coordinator closed and released its shared lock. Native response usage was reparsed separately from the ledger and priced using integer nanodollar arithmetic. Run/request IDs, terminal completion, CLI usage, source manifests and candidate artifact hashes all reconciled. All 113 Term2 cost records match exact per-dimension micro-dollar rounding; Pi finalized cost/usage matches independently priced native usage.

| Provider | Runner | Frozen rubric passes | Requests | Native-usage price estimate |
| --- | --- | ---: | ---: | ---: |
| OpenAI | Term2 | 5/6 | 69 | $0.038867965 |
| OpenAI | Pi | 5/6 | 71 | $0.026724635 |
| Anthropic | Term2 | 6/6 | 44 | $0.054545680 |
| Anthropic | Pi | 6/6 | 32 | $0.043313075 |

Both runners pass 11/12 frozen task runs. Term2 costs $0.093413645 versus Pi's $0.070037710: 33.3762% higher. OpenAI's premium is 45.4387%, despite Term2 making two fewer requests; Anthropic's is 25.9335%. All failed-quality runs remain included. These are native-usage standard-price estimates, not provider invoices or universal performance claims.

Current cost-gap decomposition:
- OpenAI difference $0.012143330: cache writes $0.010823500 (89.1%), reads $0.000934930, output $0.000385500, fresh input -$0.000000600.
- Anthropic difference $0.011232605: reads $0.004342580 (38.7%), writes $0.003010625 (26.8%), output $0.003877000 (34.5%), fresh input $0.000002400.
- All 63 Term2 Luna continuations refer to the immediately preceding response and omit repeated additional_tools declarations. Six zero-cache-read continuations remain observed, one per run; no cause is established. No paid failed-HTTP request or retry is observed, so the earlier retry-ownership correction has no demonstrated live causal savings here.

Cache and protocol conditions:
Every current Anthropic Term2 first request marks the run_code tool prefix; every Pi first request marks its write tool. The tool definitions are stable across task workspaces for each runner. Four of six Term2 first requests read 8,233 cached tokens, while the other two read zero. Five of six Pi first requests read 1,310 cached tokens, while the first pagination run reads zero. Fresh conversations are therefore not uniformly cold caches. These observations establish marker placement and actual reuse, not an isolated before/after savings estimate. The historical missing-marker lead is already implemented by PR263 and must not be presented as a new/current optimization proposal.

All requests use the intended native models, medium effective reasoning and a 32K output ceiling over HTTP. Pi's Anthropic top-level low effort is accompanied by its native message-level medium marker, matching the retained SDK mechanism. In all 24 runs, actual native tool calls request the node-contracts skill read and public-test execution; matching returned tool IDs contain the skill instructions and a successful public-test TAP summary. Thus agent execution is observed separately from externally run tests. Tool/delegation/approval/sandbox implementation was not modified for this cohort; the study does not exercise every offered capability or approval path.

Artifact quality:
All 24 artifacts were independently regraded under bwrap network/PID isolation and reproduced the frozen rubric results. Supplementary requirements controls were applied identically without model repair feedback or changes to the frozen scores. All four Anthropic JSONL artifacts additionally reject revision 1e20, although the contract specifies a nonnegative integer revision and restricts only amountCents to safe integers. The other supplementary controls pass. Keep this counterexample separate from the preregistered scores; rubric success is not exhaustive contract acceptance.

Shared budget:
The same physical ledger retains 200 earlier native requests plus 216 current requests: 416 metered requests across 48 live task runs. Their combined estimate is $0.320432550. The earlier uncaptured-preflight exposure remains conservatively reserved at $5.286, yielding $5.606432550 total exposure, below the approved $10 cap. No new unresolved usage exists. The retained external amount is an upper bound, not a claim of that much actual spending. The original cohort and its failures/charges remain counted rather than being replaced by the refresh.

Evidence files:
- current-live-audit.mjs / current-live-audit-results.json: per-request native/CLI/hash reconciliation, with cohort metadata rather than positional parsing of IDs.
- current-final-decomposition.json: exact group totals and cost components.
- current-chain-cache-rounding.mjs / current-chain-cache-rounding.json: continuation, rounding and cache-marker checks.
- current-artifact-grade.mjs / current-artifact-verification.json: isolated frozen regrading and supplementary checks.
- current-instruction-compliance.mjs, current-tool-result-compliance.mjs and their JSON outputs: actual skill/test execution traces.

The verifier made no inference calls, candidate source changes, edits to the four frozen harness files, or model rework requests. Archive validation is a separate integrity check; its final hash can be recorded outside the archive to avoid a circular manifest dependency. The accepted conclusion is limited to this measured cohort and does not establish general Pi parity, exhaustive software acceptance, or achievement of the original efficiency goal.

Archive integrity acceptance:
The final combined evidence.zip is accepted at SHA-256 6cbd2f910eb5281154a1a16e3e8a20f26f2e9b15015ccaaa7b81a02cc061c3fd (12,591,394 bytes). Its adjacent checksum file matches the independently recomputed digest. All 1,776 manifest entries were checked for length and SHA-256 integrity. All 836 original historical entries remain byte-identical under their documented mapping; the 400 historical native request/response files remain in the shared wire tree rather than being duplicated in a historical subtree. The archive contains 24 current-main and 24 historical live outcomes, with 216 and 200 requests respectively; all 416 shared native exchanges are present exactly once. Current fixtures are separated from live outcomes, client state/credential files are excluded, historical runtime/provenance is preserved, and total exposure remains $5.606432550. Active-writer and tampered-historical-manifest rejection were separately exercised before export. No archive integrity blocker remains. This acceptance note is intentionally stored beside the archive rather than inside its own hashed manifest.
