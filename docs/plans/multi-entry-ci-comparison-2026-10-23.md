# Hosted multi-entry CI comparison

Baseline: PR35 head 9e598ab60485bbae0fe8568b60d052b3336d3c79.
Temporary experiment only: no PR update, merge or release.

## Frozen contract

Compare the existing PR bundle with the six-runtime-entry bundle through the
same complete four-job Ubuntu workflow. Keep setup, caches, frozen dependency
installation, runner count/class, assertions, deadlines and discovered inventory
unchanged. Both variants compile once within the real build/rollback pipeline;
no prebuilt input is supplied from another job or outside the timed workflow.

Run sequentially in baseline/runtime/runtime/baseline/baseline/runtime order:
three observations per variant, no overlapping experimental workflows, no
cancelling a failed or slow run to improve results. A test/setup/build failure
is retained as failure, not silently replaced with a successful timing sample.
Stop for diagnosis on a failed run; do not keep spending runner time blindly.

Measure workflow creation to terminal workflow updated_at as an explicitly
imperfect complete-feedback metadata proxy; also report first job start to last
job completion and aggregate job seconds. Record queue/setup/build/test/cleanup
separately where GitHub timestamps permit. Preserve publication/observation delay
rather than substituting job completion for terminal workflow completion.

Retain all individual observations and CPU/resource logs. Report cache hits,
runner image and failures. No threshold for acceptable speed regression is
invented: overlapping/noisy ranges leave the performance decision uncertain.
Verify all 488 test cases remain accounted for. No permanent unit tests.

The comparison is not independent production verification, platform coverage,
or a recommendation to ship the packaging migration. Those gates remain open.

## Results

All six planned successful runs used the same four Ubuntu runners, Node 24.21.0,
pnpm 11.7.0 and frozen dependencies. Every run passed 486 cases with two existing
skips, accounting for all 488 cases. No test source, timeout or worker limit was
changed. The candidate was built once per job through the real rollback build
pipeline, not compiled ahead of the timed workflow.

| Order | Variant  | Cache                     | Job span (s) | Feedback metadata (s) | Runner-seconds | Build/test CPU seconds | Run                                                                   |
| ----- | -------- | ------------------------- | -----------: | --------------------: | -------------: | ---------------------: | --------------------------------------------------------------------- |
| 1     | baseline | dependency/ripgrep misses |          124 |                   128 |            404 |                 282.83 | [39978230929](https://github.com/qduc/term2/actions/runs/39978230929) |
| 2     | runtime  | hits                      |           72 |                    76 |            264 |                 314.66 | [39978576252](https://github.com/qduc/term2/actions/runs/39978576252) |
| 3     | runtime  | hits                      |           73 |                    76 |            248 |                 280.20 | [39978854905](https://github.com/qduc/term2/actions/runs/39978854905) |
| 4     | baseline | hits                      |           69 |                    73 |            249 |                 281.41 | [39979132884](https://github.com/qduc/term2/actions/runs/39979132884) |
| 5     | baseline | hits                      |           69 |                    72 |            231 |                 260.64 | [39979412493](https://github.com/qduc/term2/actions/runs/39979412493) |
| 6     | runtime  | hits                      |           71 |                    74 |            250 |                 277.96 | [39979696491](https://github.com/qduc/term2/actions/runs/39979696491) |

The first baseline has four dependency-cache misses and two ripgrep-cache misses.
It remains in the results but is not a matched cold/warm comparison: no cold
candidate was measured. Later observations all hit their dependency and binary
caches. Comparing the first cold baseline to a warm candidate would falsely
attribute setup savings to the bundler.

For the comparable warm observations (two baseline, three candidate), baseline
job spans were 69/69 seconds versus 72/73/71 seconds. Feedback metadata was
73/72 versus 76/76/74 seconds. Thus this experiment does **not** establish a CI
speed improvement: the candidate was 2-4 seconds slower in these finite warm
job-span observations. There is no pre-agreed acceptable-regression threshold
or non-inferiority proof, so do not label the timings equivalent.

Across all three samples per variant, baseline/candidate medians were 69/72
seconds job span, 73/76 seconds feedback metadata, and 249/250 runner-seconds.
The profiling comparison tool returned exit 3 (overlapping ranges) for job span,
feedback, runner-seconds and build/test CPU. These mixed-cache aggregates are
retained for completeness, not offered as a causal performance claim.

### Phase observations

Warm setup-step totals across four jobs were 35/34 seconds baseline versus
38/39/37 candidate. Build-step totals were 21/21 versus 24/22/24 seconds. Test-step
totals were 163/150 versus 175/161/161 seconds. Post-step totals were 1/4 versus
4/2/2 seconds. Totals across jobs are not critical-path elapsed time. They do not
identify a stable new bottleneck; the E2E lane still had roughly 47-49 second
test stages. Runner/setup variance remains material.

CPU totals sum the eight /usr/bin/time build/test observations (four of each);
they exclude setup CPU. Runner-seconds include setup and cleanup. Unchanged
required work remains inside each workflow.

### Publication, duplicates, and rejected evidence

Feedback metadata means workflow created_at through terminal updated_at. It
includes the observed scheduling/setup/build/test/cleanup/publication interval,
but updated_at is mutable metadata, not a dedicated notification timestamp.
Raw job timestamps and terminal-observation times are retained separately. The
watcher used 30-second polling, so its observation time is an upper bound rather
than a precise notification time.

GitHub created two push-event workflows for baseline head 55cd61ff. Existing
concurrency automatically cancelled run 39979408575; it consumed eight additional
runner-seconds. The other run completed normally. The driver stopped on the
unexpected duplicate and was resumed only after retaining both records. No
repeat push, manual cancellation, replacement successful sample or discarded
slow run was used. Total runner time for the six successful runs was 1,646
seconds, plus the cancelled duplicate's eight seconds: 1,654 seconds altogether.
The duplicate's scheduling history remains a confounder for that observation.

Initial forced lint on normally ignored mjs files lacked Node-global config;
explicit Node globals were supplied to the focused lint command, which passed.
Background shell execution was unavailable, so the finite driver ran foreground.
Neither infrastructure issue is counted as a workflow timing sample.

## Decision

**Diagnostic result: do not adopt this as an additional test-speed optimization.**
The runtime-entry candidate is a package-size trade-off with similar-order but
slightly worse observed complete CI time, not a faster-test result. The prior
local measurements found about 29% smaller archives and 7% smaller fresh
production installations. Those are separate benefits, not evidence of faster CI.

No one-minute full-feedback target was achieved. No PR or main change, merge,
release, paid-provider call, additional runner class/count, cache deletion, or
expanded access was needed. The temporary branch trigger and variant environment
are removed after the measurement sequence; the remote experiment branch and
all run links remain available for inspection.

Packaging remains **unverified for adoption**: independent verification is not
available in this session, filesystem/deep-import compatibility needs an explicit
disposition, and broader supported Node/platform coverage remains pending.
This report closes only the bounded hosted measurement, not the packaging change.

Raw observations, phase timestamps, resource readings, cache misses, inventory,
terminal-observation limits and duplicate overhead are retained in the adjacent
results JSON. Full logs remain accessible from each linked GitHub run and in the
local multi-entry-bundle worktree under .bundle-experiment/hosted.
