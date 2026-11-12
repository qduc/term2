# Medium historical-task comparison

Frozen before live execution. This study supersedes the small-task comparison and
is head-to-head unchanged Term2 Bare versus Pi 1.5.2. Sandbox is disabled in Term2;
both applications automatically approve tools. The outer controller isolates
credential-free acceptance tests with bwrap; that is not the agent shell policy.

Task: reconstruct the built-in OpenRouter migration (base c5f0002c; historical
reference 7b63338f), spanning 15 files and 494 insertions/442 deletions. Every run
gets the full same base Git archive, a fresh local single-commit repository with
no upstream remote/history, its own installed dependencies, and task.md. The
reference implementation and hidden oracle are not copied into agent workspaces.
With sandbox off these are process/workspace conventions, not a security boundary.

Native models: gpt-6-luna and claude-haiku-5-5, medium reasoning, HTTP, maximum
32,000 output tokens per request, no hosted paid tools. Five repetitions per
provider/runner, alternating runner order, serial execution: 20 planned runs.
No per-output repairs or feedback from the external grader. All agent attempts,
failures, retries and native requests count. A bounded 20-minute task timeout is
failure. Model/backend variability remains; no general capability claim follows
from a single historical task.

Frozen acceptance: TypeScript, 43 reference HTTP contracts, 15 independent registry
HTTP/SSE checks, dependency removal and other dependencies unchanged, offline
frozen-lock importer consistency, architecture/layer/rule/complexity guards, and
instruction integrity. Only the historical reference's exact deletion of one
obsolete complexity allowance is permitted in addition to the base guard bytes.
Candidate test modifications cannot change the frozen tests. Supplemental coverage
includes failed streams, metadata, tool/reasoning continuation and other-provider
isolation. Held-open errors with an active recorder remain explicitly excluded.
Module documentation and candidate-authored coverage require qualitative review;
a green automated grade alone does not establish those claims or general quality.
Lint and formatting are reported separately for green candidates before claiming
completion. Reference full-src lint has zero errors (39 warnings); formatting passes.

Lock grading strips only devEngines in the grader's manifest copy to avoid pnpm's
registry-required executable bootstrap; dependency scope checks the original.
`--trust-lockfile --frozen-lockfile --offline` verifies importer consistency without
registry supply-chain revalidation. No packages are installed by that step. This
is not evidence that new dependencies are safe; new dependencies are disallowed.

Setup includes dependency installation and creating the runtime's private
TMPDIR/agent/term2-nodejs directory, needed by sandbox-off Term2. Both runners
receive these directories. Setup is excluded from agent time and reported
separately. Agent wall time is CLI spawn through exit; total elapsed additionally
includes billing settlement, artifact capture, and external grading. Preserve
all final source changes, native wire captures, prompts, settings and hashes.

Costs come from native usage, including caching and output/reasoning, independently
priced by the unchanged PR267 budget gateway. All paid runs use the existing shared
physical cumulative ledger. Approved cumulative cap remains $10, with initial
$1.410903305 metered plus $5.286 conservative prior unresolved reserves: exposure
$6.696903305. Never reset it. Each send reserves a worst-case bound first; halt on
unresolved usage or inadequate headroom. Fake-provider costs are fictional and
excluded from paid totals. Report run counts, pass rates, request/cost/time medians,
means, ranges and sample standard deviations, paired differences, and incomplete
cells. With n=5 and one task, results are descriptive, not a universal ranking.
