# Inconclusive: stopped on capability guardrail failure

Paid work stopped after one complete matched pagination pair and an interrupted
classifier treatment. All **24 physical native requests** are metered:
**$0.009997785 estimated**, **$0 uncertain exposure**, no pending requests.
The $100 total investigation cap retains $99.990002215 at published rates.
No provider invoice was obtained; these amounts are native-usage price estimates.

## Measured comparison

| Pagination r1 | Baseline | Session-Id treatment |
| --- | ---: | ---: |
| Completed runs | 1 | 1 |
| Physical requests | 11 | 8 |
| Native input tokens | 87,773 | 59,763 |
| Native cached-read tokens | 77,071 | 49,972 |
| Native cache-write tokens | 10,669 | 9,767 |
| Derived fresh input tokens | 33 | 24 |
| Native output tokens | 3,780 | 4,093 |
| Sum of physical HTTP durations | 51.629 s | 44.989 s |
| Median physical HTTP duration | 3.869 s | 4.627 s |
| Cost estimate | $0.003997635 | $0.003769495 |
| Derived writes above largest cached+written context | 0 | 0 |
| Zero-read continuation requests | 0 | 0 |
| External rubric | 14/14 | 14/14 |

The treatment's cost is 5.71% lower, requests 27.27% fewer and summed HTTP time
12.86% lower; per-request median is higher. These are descriptive associations,
**not causal savings**. Different stochastic/recovery trajectories confound them,
the sample has only one pair with baseline first, and order balancing was not
completed. The original cache-rewrite symptom did not reproduce in either arm.
There is no evidence here that the header fixes it. The hypothesis is inconclusive,
not established or generally refuted.

The interrupted classifier treatment adds 5 requests, 30,794 input tokens,
23,628 cached reads, 7,151 cache writes, 2,198 output tokens, 22.108 s of summed
HTTP duration and **$0.002230655**. It has no matched control or completed quality
outcome and is excluded from the table, but included in total spend and tokens.
Total native input=178,330, cached reads=150,671, cache writes=27,587,
output=10,071; derived fresh input=72. Native counters and derived arithmetic
remain separate. Every retained request ended completed with HTTP200 and usage.

## Why the capability guardrail failed

The configured environment lacks `socat`. Native tool results explicitly report
`Shell sandbox unavailable (missing_dependency): socat not installed. The command
was not run.` Both agents recovered by requesting unsandboxed shell commands.
The completed baseline had two missing-dependency results; treatment had one;
the interrupted classifier had one. These recoveries change request/latency cost.

Independent inspection also found the agents' requested public-test commands were
denied by Term2's heuristic approval: YELLOW with no configured auto-approve model
(and one treatment focused command classified RED). Neither completed run actually
executed its requested public tests. Both artifacts passed the separately executed,
isolated public tests and frozen 14-check external rubric. External grading is not
agent test execution or proof of preserved sandbox/approval capability. Offered
surfaces were retained, but the intended execution guardrail was not met.

A reply-only no-cost fixture and bare bwrap probe failed to establish real shell
capability. This was a preflight-design gap. On discovery, the coordinator's child
was paused while the current upstream request settled, then both were stopped.
An earlier signal attempt found the prior child had already exited and had no
effect. All subsequent requests before successful stop are included. The stale
lock metadata is retained separately after verifying the coordinator no longer
exists and every reservation reconciled. Interrupted classifier stdout buffered
by the coordinator was not flushed on SIGTERM; native exchanges and task files
were retained. No capability repair or additional paid campaign was attempted.

## Provenance and verification

PR271 fetched head: `b1c2e4df329a371d2867f4224ba72ca83220e8a4`.
Frozen harness: `86f466f4357f1ad9970c08f13445ac58bee4b411`.
Exact live tested commit: `5c5488ccda595677c27df11b84bd971a1ed67824`.
The latter adds preflight/blocker documentation; product source, package/lock and
experiment code match the frozen harness. A fresh build/provenance receipt at the
live commit is included in the archive. Model gpt-6-luna, native HTTP streaming,
medium effort, 32K ceiling, native previous_response_id chaining, store omitted,
fresh per-run cache keys, same scratch path, task inputs, prompt/tool schemas,
sandbox setting and auto-approval configuration were fixed across arms.

Independent audit reparsed all native terminal usage and repriced using integer
nanodollars; all ledger amounts, header assignment, body hashes, chaining, keys,
store omission, effort, output ceilings and retained artifact hashes reconcile.
Only treatment adds Session-Id=existing cache key; x-client-request-id is not added.
The matched initial bodies are equal after removing independent cache keys.
Outgoing hashes equal incoming hashes. Native server/cache-routing identity is
not available; retained edge/routing headers do not establish backend identity.

Local build and nine existing affinity integration cases passed. Three real CLI
loopback fixtures passed baseline/affinity/baseline-after and independent budget,
concurrency, no-leakage, missing-usage and restart controls passed. Synthetic
fixture counters are not provider calls/charges and are excluded from live totals.
No hosted CI is claimed. No product changes, account changes, production defaults,
merge or deployment occurred.

The first two live launches were denied before execution. Original user approval
was verified between them; the remaining destination/payload approval requirement
was subsequently explicitly approved in the parent thread. The successful launch
followed that new evidence. Those denials incurred no requests or reservations.
See approval-block-history.json for the superseded zero-spend checkpoint.

## Reproduce and next step

Verify SHA256SUMS, extract live-evidence.zip to an empty directory, then run:

```sh
python3 independent-live-audit.py /path/to/extracted-evidence
```

Read summary.json, spend-ledger.json, independent-live-review.md and the retained
physical ledger. Client state/cache and credentials are excluded; opaque encrypted
reasoning is redacted. Stop metadata, all 24 exchanges, completed and interrupted
artifacts, build receipt, manifests and protocol are retained.

The next evidence-backed step is **no-cost environment repair and a tool-using
preflight**: provide the sandbox's missing socat dependency and validate actual
skill read, source edit and test execution through the same Term2 approval and
sandbox path. The scoped package installer helper is absent in this session;
no sandbox/approval policy was weakened to hide these failures. Only after these
checks pass should a new preregistered balanced cohort be considered, retaining
this campaign's full spend in the shared $100 ledger. Do not infer production
benefit from this incomplete sample or resume the interrupted run as a clean pair.
