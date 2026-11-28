# Original generated verification pilot

The initial history and queue pilot merged in `7561e1df` on 2026-10-24.
The [current guide](README.md) lists the supported properties, how to replay
counterexamples, and the later fixed-seed CI policy. The maintainer authorized
persistent bounded generated checks as an exception to the permanent-unit-test
ban.

## What the pilot established

The installed checker generated bounded action sequences against production
history and queue code. It produced structured failure output with revision,
seed, shrink path, and runtime. Its original evaluation budget was 1,000 cases
per property, at most 30 actions or entries per case, and a 30-second runtime
target per installed invocation on the evaluation host.

The checker found a real queue lifecycle defect. Removing the last item from
a failure-paused queue left it empty and paused, blocking newly submitted
input. Restoring a persisted empty failure pause had the same problem. The
repair released an empty pause at the queue owner, including on restoration.
A nonempty failure pause and cancellation awaiting its active execution
kept their existing ownership. [Independent discovery](independent-discovery.md)
describes the red cases and follow-up controls.

An early installed-command check failed before sampling with `spawnSync git
EPERM` in the managed workspace. A broader-permission run provided supporting
evidence. The final launcher worked without that fallback and the independent
normal-workspace check passed 9,222 cases across samples and replays. Its
[report](checks/final-fresh-use/REPORT.md) distinguishes checker time (1.226
seconds) from command wall time (24.792 seconds) and records the reporting
interruption. The [failed installed-use report](checks/fresh-installed-use/REPORT.md)
and [supporting run](checks/approved-installed-use/REPORT.md) retain the
intermediate evidence.

## Decision and limits

The original promotion decision retained the checker as opt-in tooling. The
maintainer later enabled fixed-seed CI in `9ce813cde`. The pilot demonstrated
one supported defect, reproducible shrinking, and a small bounded execution
cost. It did not measure total engineering effort or prove broader correctness.

The historical full integration run reproduced four matching Bare CLI sandbox
failures on the unchanged comparison base. A provider PTY wait failed once,
then passed in a focused retry and in a complete CI-mode rerun. No cause was
established for the first timeout. The
[frozen trial record](https://github.com/qduc/term2/blob/c455d16c56dfa1d46664c0b3183873100942bf65/docs/experiments/generated-verification/PLAN.md)
retains the preregistered criteria, detailed triage, portability investigation,
and merge-time verification. Historical raw captures are available in
[the v1.3.0 archive](https://github.com/qduc/term2/tree/v1.3.0/docs/experiments/generated-verification/checks).
