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

## Observation marker

Run 2/6: runtime. Sequence fixed before measurements.
