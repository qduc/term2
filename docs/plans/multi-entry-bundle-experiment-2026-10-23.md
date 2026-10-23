# Multi-entry packaging experiment

This is the retained **local-phase** record, not the final hosted-CI decision.
The subsequent complete-workflow comparison and final interpretation are in
[multi-entry-ci-comparison-2026-10-23.md](multi-entry-ci-comparison-2026-10-23.md).
Earlier decisions and unmet gates below are scoped to this phase; later hosted
build integration does not imply independent production verification.

Baseline: PR35 head `9e598ab60485bbae0fe8568b60d052b3336d3c79`.
The initial isolated diagnostic did not authorize PR updates, merging, or
publishing. The user subsequently authorized the hosted comparison and recording
the complete experiment on PR35. Neither authorizes merging or releasing.

## Frozen comparison contract

Question: can multi-entry bundling remove duplicate emitted application code
without losing CLI startup performance or runtime contracts?

First candidate preserves emitted entry paths with re-export wrappers, bundles
JavaScript entries together into a flat chunk directory, initializes the
environment before the CLI, and retains assets, CommonJS preloads, declarations,
and embedded/external package boundaries. Preserve every emitted JavaScript
entry initially rather than guessing which deep imports may disappear.
Do not prune dependencies.

- Measure archive bytes, unpacked bytes, and file count for both variants.
  Fresh production-install size is separate, not checkout node_modules.
- Alternate ten baseline/candidate samples per help/version workload and
  bytecode-cold/warm condition. Use fresh homes and processes. Cold means a
  disposable bytecode cache, not flushed OS caches. Retain elapsed and CPU data.
- Failed launches are correctness failures, not performance samples.
- Report medians and ranges. No numerical materiality threshold was supplied:
  measurements inform the decision but do not authorize adoption.
- Verify packed relocation without checkout source/build tools: environment
  modes, version, prompts/presets, worker indexing, sandboxed execution, hooks
  declarations, and required entry paths.
- Run four unchanged CI lanes. Distinguish baseline failures from regressions;
  never weaken assertions, deadlines, or process isolation.
- Packaging failure-path evidence and independent verification are required
  before a production-ready claim. No independent-agent tool is exposed in this
  session; that gate remains pending, not waived.
- Linux/current Node is the first slice; other environments remain unverified.

## Budget

One conservative candidate and at most one evidence-driven revision initially.
Stop early on decisive incompatibility or no useful size benefit. Keep rejected
evidence. Do not broaden into dependency pruning or platform redesign.
Temporary scripts/generated output are not production build changes.

## Evidence

Pending executed measurements. Six CLI integration failures reproduced on both
PR head and base during review; that is context, not candidate verification.

## First bounded experiment results

Environment: Linux x64, Node v24.19.0. Build and measurement dependencies came
from the PR lockfile, using pnpm 11.7.0. Fresh consumer installations reported
pnpm 11.20.0 and resolved newer versions allowed by the published dependency
ranges. Both fresh consumers had identical inventories of 269 dependency
snapshots (excluding the package under test). Measurements are local, not hosted
CI feedback-time measurements.

| Artifact                          | PR baseline | All-module entries | Runtime entries |
| --------------------------------- | ----------: | -----------------: | --------------: |
| Archive bytes                     |   8,088,600 |          7,418,645 |       5,735,577 |
| Unpacked package bytes            |  41,843,563 |         39,132,569 |      30,782,154 |
| Archive files                     |       3,600 |              6,744 |           1,928 |
| Fresh production node_modules KiB |     209,300 |      not installed |         194,624 |

The all-module candidate is rejected: its small archive reduction came with
roughly 50% worse help/version startup and nearly twice the file count. This
shows that mechanically preserving every module as a shared-bundle entry is not
an acceptable implementation of the idea.

The single revision uses six entries: CLI, session-index worker and client,
sandboxed-code host, worker-bootstrap helper, and hooks index. Stable wrappers
remain at these original paths. Other emitted JavaScript and its stale maps are
removed; declarations, assets, environment setup, CommonJS preload, and embedded
agent-wire remain. This is **not** a demonstration that arbitrary old filesystem
deep imports remain compatible. No dependency declarations were removed.

### Startup, alternating samples

Each cell is median milliseconds over ten fresh timed processes. Warm is a
second process sharing only its immediately preceding priming process's bytecode
cache. Workloads share the host and OS caches. CPU and individual observations
are retained in the adjacent evidence JSON.

| Workload               | PR baseline | Runtime candidate |
| ---------------------- | ----------: | ----------------: |
| Help, bytecode cold    |      493.86 |            489.35 |
| Help, bytecode warm    |      345.94 |            348.75 |
| Version, bytecode cold |      493.35 |            495.62 |
| Version, bytecode warm |      344.60 |            351.51 |

The profiling comparison tool returned exit 3 for every pair because observed
ranges overlap. There is no established speed improvement or equivalence claim.
The warm medians are slightly worse; this remains a guardrail to investigate,
not a result to round away. These are help/version startup observations, not
interactive-turn latency or complete CI measurements.

### Correctness observations

The runtime candidate ran all four unchanged CI lanes:

- Test: 89 passed, six failed. The failing scenarios are the same six reproduced
  on PR head and its unchanged base during the earlier review.
- Integration: 159 passed, one skipped.
- E2E: 66 passed, including source/built worker startup and deleted-cwd cases.
- Provider: 166 passed, one skipped.

Both freshly packed artifacts were installed outside the checkout, with real
production dependencies rather than a symlink to checkout node_modules. Both
passed version in unset/test/production modes, real SQLite FTS capability probes,
sandbox execution returning 42 without exposing process, preset inventory reads,
and hook declaration checks. Both rendered interactive input readiness and exited
0 through the user-facing double-Ctrl+C contract in all three environment modes,
using a loopback provider fixture and no paid-provider requests.

Typecheck passed. The first focused ESLint invocation ignored the temporary mjs
files, so that command is not counted as lint validation.

### Rejected or corrected evidence

- The first temporary generator had a quoting syntax error; no candidate build
  from that attempt was measured.
- npm pack rejected the package's pnpm devEngines contract. Archives were instead
  produced with pnpm pack, without weakening that contract.
- Offline consumer installations failed for missing cached web-fetch metadata;
  normal online installs then succeeded. The failed logs are retained.
- An initial worker-probe assertion expected an available field. The actual
  ProbeCapabilityResult contract is `{ok:true}`; the corrected probe passed.
- An initial UI fixture wrote settings under configDir instead of the established
  harness logDir. It rendered onboarding, not idle chat. Those timeouts are not
  product failures; corrected settings produced the successful UI observations.

## Decision and remaining gates

**Diagnostic only: continue with the runtime-entry design, reject the all-module
entry design. Do not update or merge PR35 from this evidence.** The runtime
candidate reduces archive bytes by about 29%, unpacked bytes by about 26%, and
fresh production disk footprint by about 7%, with broadly similar sampled startup.

Unmet gates: independent verification, production build/rollback integration,
explicit compatibility disposition for removed filesystem entry paths, relocated
provider-turn/prompt behavior beyond startup/worker probes, and other supported
Node/platform combinations. No numerical acceptable startup-regression threshold
has been chosen by the human; the overlapping samples are not an adoption gate.

The experiment lives in `.worktrees/multi-entry-bundle` on
`experiment/multi-entry-bundle`. Production source, build scripts, PR35, and the
primary checkout were not changed. Temporary generators, packed artifacts, raw
logs and metafiles are under `.bundle-experiment/` and the two
`scripts/experiment-*.tmp.mjs` files. They remain untracked for resumption and
are not intended as permanent unit tests or production build machinery.

The adjacent `.evidence.json` retains raw samples, comparisons, fresh dependency
inventories, installation outcomes, packed worker/UI observations, and test log
provenance. Temporary scratch installations are recorded there as well.

Focused ESLint subsequently passed with `--no-ignore` after adding explicit Node
imports to the temporary generators; without the normal ignore, Node globals
were otherwise unconfigured. Prettier passed for the retained evidence paths,
and the no-unit-tests guard passed. This is not a claim that full repository lint
was run. The candidate artifact remains active at the isolated worktree's dist;
the untouched original build is retained at `.bundle-experiment/original-dist`.
No task-completion ledger row is added while the production-readiness gates are
still pending.
