# Hidden SDK retry investigation

This is a bounded continuation of the Term2/Pi efficiency investigation, using
source base `d285292b752a0e40c8ab37648b088a0289310b9a`. It establishes excess HTTP
attempts under deterministic failures, not lower provider bills or Pi parity.
No paid provider inference was authorized or performed.

## Mechanism and change

Custom `openai` and `openai-compatible` providers, plus OpenCode's Chat and
Responses routes, configured two OpenAI SDK retries beneath Term2's retry owner.
With `agent.retryAttempts = 2`, a failed engine-owned dispatch therefore sent
three POSTs before returning to request preparation. A standalone ModelRegistry
call exhausted after nine POSTs rather than three. These repeated the complete
request body, including instructions, tools and history. A hidden successful
retry could also finish before the engine had a chance to apply steering.

Disable SDK retries on those four constructors, matching OpenRouter's existing
ownership pattern. `physicalModelStream` remains responsible for standalone
ModelRegistry retries; engine-owned requests return failures to the engine.
Eager source definitions retain their existing `RetryingModel` wrapper.
Instructions, tool definitions, skills, delegation, approvals and sandbox code
are not shortened or removed.

Independent review found a compatibility gap in the first candidate: the SDK
retried HTTP 408/409, but Term2's outer classifier did not. The final change
classifies those actual OpenAI `APIError` instances as retryable, preserving
Retry-After. Generic vendor 408/409 objects retain their previous classification.
Term2's centralized policy remains authoritative: an SDK `x-should-retry` hint
does not override authentication, invalid-request or long-delay refusal. Thus
an endpoint relying on `x-should-retry: true` to conceal such a failure can now
surface it instead. This is an intentional admission-policy boundary, not a
claim of complete SDK retry-policy equivalence.

## Reproduction and evidence

The persistent regression crosses the actual ModelRegistry → provider factory →
OpenAI SDK → loopback HTTP boundary. It launches no CLI processes and blocks
external requests through the integration tier's network guard. Its synthetic
credentials, schemas, prompts and replies contain no user data. Server scripts
return 429, 408 or 409 failures and minimal successful SSE responses.

Run from a dependency-installed checkout after `pnpm build`:

```bash
NODE_ENV=test pnpm exec vitest run --config vitest.integration.config.ts tests/model/custom-provider-retries.integration.test.ts --reporter=verbose
```

On unchanged production source, the original 16 regression cases all failed for
the expected behavioral reasons. The intermediate SDK-only fix then failed the
new timeout/conflict controls. The final checks cover bounded exhaustion,
successful recovery, visible retry events, explicit engine re-entry with updated
instructions, unchanged tool payloads and timeout/conflict recovery. `results.json`
retains normalized runner evidence and source hashes; raw session-local reports
are in `.handoff/`. Reproduce the original failure by running the regression file
against the stated base production files. No permanent unit tests or static
guards were added.

| Fixture scenario, each of four routes | Base observation | Final required behavior |
| --- | --- | --- |
| Engine reservation, persistent 429 | 3 POSTs | 1 POST, retryable failure returned |
| Standalone exhaustion, persistent 429 | 9 POSTs | 3 POSTs, then failure |
| Standalone 429, 429, success | 3 POSTs, 0 retry events | 3 POSTs, 2 retry events, success |
| Engine 429, then explicit recovery | Hidden retry finished with old instructions | Failure first; next dispatch uses updated instructions |
| SDK 408/409, then success | SDK recovers internally | Term2 recovers with a visible retry |

The 3→1 and 9→3 reductions are 67% fewer fixture POSTs in those failure cases.
They are not token or dollar savings. The successful 429/429/200 path still uses
three POSTs. All failed attempts are counted; a terminal error is not scored as
a completed task. Wire request bytes are not provider input tokens, and a 429
may reject inference before any charge. Fixture usage values are synthetic and
must not be priced as real work.

Local validation of the final production source: 20 new integration cases plus
nine existing provider-affinity cases passed (the new file used about 557 ms of
test time and zero built-CLI launches). Full provider black-box validation passed
270 tests with five suite-owned skips. Typecheck, static guards (22 tests),
architecture/rules/reachability/complexity/callback checks and the baseline gate
passed with no added deviations. ESLint retains 40 existing warnings. Independent
verification accepted 66 cases, comprising the author's 20 plus 46 additional
controls; its [review note](independent-verification.md) separates its evidence
from author checks. The final source hashes in `results.json` match the checked
files. CI and live-provider acceptance are separate from these local results.

## Related work and rejected lead

[PR265](https://github.com/qduc/term2/pull/265) corrects array-union tool guidance;
this branch does not repeat that change. Its reported CI and local checks are
separate evidence. [PR259](https://github.com/qduc/term2/pull/259) separately
preserves failed/incomplete Responses usage, which matters to future full-cost
comparisons. Neither PR's author claims establish the overall quality/cost goal.
The earlier 72% tool-definition byte share and historical Anthropic/OpenAI token
differences remain reported leads: the lost archive was not recovered here.

A proposed cache-lookback fix was rejected before implementation. Current
[Claude documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
says consecutive tool-use and tool-result runs each count as one lookup position;
a large parallel tool batch alone therefore does not demonstrate a cache miss.
This investigation makes no cache-hit-rate claim.

## Remaining acceptance and spending boundary

Loopback success proves request/recovery behavior, not model planning quality.
No fresh Pi comparison, live provider cache measurement, invoice reconciliation,
merge, release, deployment or account change was performed. CI outcomes must be
reported separately from local checks and independent review.

The overall objective—completed work at least as good as Pi for equal or lower
total API cost—remains unverified. A next live comparison needs an explicitly
approved budget and exact model IDs. Suggested initial cap: **US$10 total**,
covering native OpenAI and native Anthropic, three small coding tasks, two paired
repetitions per runner/provider (24 runs), with US$8 for runs and US$2 reserved
for retries/failures. Stop at the cap; include abandoned/failed runs and cache
reads/writes, reasoning/output, grader checks and repair attempts in totals.
Use identical repositories, task acceptance checks, model effort and output
limits; preserve skills, tools, delegation, approvals and sandbox behavior.
Report per-task quality failures alongside aggregate cost rather than pricing
only successful runs. This proposed budget is not authorization to spend.
