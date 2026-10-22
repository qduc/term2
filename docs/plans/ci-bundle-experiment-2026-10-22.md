# Fresh CI architecture experiment

Checkpoint: PR35, `be87dae18371bd6b4c9690ae957e6e154f4cdf0e`.
Experimental branch: `perf/ci-fresh-architecture`. No merge or deployment.

## Contract and alternatives

The goal is approximately one minute for complete CI feedback, including queue,
setup, build, every required test, cleanup, and workflow success publication.
The behaviors, failure detection, isolation, and truthful reporting are requirements.
The present module graph, test-file topology, and per-tier execution stages are not.
Runner count and class remain unchanged; no paid model calls are allowed.

Three plausible directions were considered before editing:

1. Bundle the actual shipped CLI and its dependency graph, reducing repeated module
   loading in every fresh child process. Keep fresh processes and all assertions.
2. Schedule all tiers through one execution graph, eliminating serial tier barriers
   and repeated setup. This cannot alone shorten the longest provider file and risks
   becoming another round of workload balancing.
3. Separate protocol checks from terminal interaction checks and exercise each at its
   owning boundary. This has substantial assertion-equivalence risk, especially for
   the approval, resume, crash, and terminal journeys, so it is not the first experiment.

The discriminating first check was alternating cold/warm CLI starts for unbundled,
source-only bundled, and dependency-bundled artifacts. If loading is material,
bundling should lower elapsed time and CPU without reusing runtime state. A faster
`--help` is diagnostic evidence only; adoption requires complete-suite and CI evidence.

## Environment and baseline

Cloud Linux: Debian 13, Node 24.19.0, pnpm 11.19.0, four CPU-equivalents quota
(`cpu.max = 400000 100000`, five visible CPUs), about 18 GB visible RAM. These
measurements are separate from Mac and GitHub Ubuntu results. Frozen installation
used a worktree-owned installation and writable cache paths. Initial installation
failed on the read-only home cache, then succeeded with a writable node-gyp cache;
native compilation took 93.6 seconds. This is environment bootstrap evidence, not a
CI speedup measurement. GitHub retains its configured Node 24.21.0/pnpm 11.7.0.

Verified GitHub checkpoint run `39804107808`: all four jobs successful. API job
timestamps currently yield 93 seconds first job start to last completion, 96 seconds
from workflow creation, and 323 aggregate job-seconds. Workflow `updated_at` is also
96 seconds after creation in this snapshot; it is mutable metadata, not a dedicated
publication timestamp. These observations are distinct from the earlier supplied
91/94/104 second observation and 299 runner-seconds. No lower bound is inferred.

## Diagnostic results and rejected evidence

Three alternating samples per mode/cache state, fresh home and fresh process for
every launch; warm means a second process using only the first process's bytecode.
Timing includes process start/exit. CPU uses child resource usage. Build cost is
separate here and must be included in complete CI comparisons.

| Variant | Cold median | Warm median | Warm CPU median | Outcome |
| --- | ---: | ---: | ---: | --- |
| Checkpoint CLI | 1.076 s | 0.809 s | 1.089 s | exits 0 |
| Source-only bundle | 1.113 s | 0.752 s | 1.155 s | insufficient gain |
| Split dependency bundle | 0.583 s | 0.420 s | 0.504 s | diagnostic candidate |

The source-only bundle traversed 768 application modules. The final diagnostic
bundle traversed 2,787 application/dependency modules and took 1.08 seconds to build.
This does not establish a complete CI improvement.

Rejected attempts are retained: initial bundling broke relative prompt paths;
preserving only `import.meta.url` missed `import.meta.dirname`. Bundling with Ink
external gave only a modest startup gain. Bundling Ink into one nonsplit file made
the optional developer-tools dependency eager and failed startup. ESM splitting
restored lazy loading and passed all help launches. These failed starts are never
counted as performance wins. The preliminary RSS statistic is a cumulative process
high-water mark and is not suitable for comparing individual startup variants.

## Status

The first full local provider comparison passed the same 222 tests with the same
one existing skip in each variant. Checkpoint: 182.60 s elapsed, 118.11 s child CPU,
434,660 KB maximum child RSS. Split bundle: 154.40 s elapsed, 79.96 s child CPU,
441,072 KB maximum child RSS. Both used two workers, fresh bytecode directories,
and identical fixture/assertion source. This is one exploratory pair, not a stable
percentage claim, and excludes build/setup. Several Codex cases took about 12 s
in both cloud variants; do not equate these measurements with GitHub Ubuntu.

Independent review identified environment initialization order, direct executable
mode/shebang, module-relative paths, and Ink development metadata as adoption
risks. The implementation uses a small unbundled launcher to establish the
environment before dynamically importing the bundle. It keeps the emitted modules
for workers and assets, uses parser-aware location replacements, and adds the
bundler as a build step covered by the existing rollback mechanism. The integration
CLI is produced through the same bundler while keeping its original emitted input
for subsequent incremental compilation.

Full behavior, package relocation, rollback, and complete feedback measurements
are in progress. No production change has earned adoption at this point.
