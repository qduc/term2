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

## Implementation and complete-run evidence

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

The packaging-only commit `2913273` passed all 486 tests with the two existing
skips on GitHub run `39809026965`. Attempt 1 was cold: 140 s first job to last
completion, 142 s feedback metadata, 397 aggregate runner-seconds. Attempt 2 had
warm dependency caches but one ripgrep image-key miss: 97 s jobs, 101 s feedback,
294 aggregate runner-seconds. A provider-lane reduction alone did not meet the
complete-loop target. Its test stage was 30.90/45.04 s in these attempts versus
about 62 s at the verified checkpoint, showing substantial runner variance too.

The next experiment treats the CLI artifact and execution queue as shared build
inputs, without sharing test state. CI integration launches the fresh production
artifact already built in its job. Each lane then uses a single Vitest queue with
two workers and separate projects retaining the original tier settings. This
removes serial phase barriers and duplicate CLI compilation. Assertion failures
do not suppress other assigned files; failures remain fatal. No cases are moved
between the four jobs. The first `extends` prototype was rejected because Vite
concatenated include arrays and ran entire tiers; its interrupted output is
retained. Explicitly overriding each original config's include fixes discovery.
The corrected local test lane passed the expected 95 tests in 31.81 s, versus
41.81 s for the serialized bundle lane (one pair, not a complete CI measurement).

Two setup details follow directly from observed costs: the ripgrep cache is keyed
by OS/architecture/Ubuntu family rather than each image publication (a cold
integration setup took 77 s); bundle source maps omit duplicate embedded source
content while retaining mappings. The initial package added 50.9 MB uncompressed
and packed to 12.6 MB, so artifact-size cost is part of the adoption decision.

The coherent candidate `f684903f` passed the complete inventory twice on run
`39811992641`: **486 passed, two existing skips, 63 files**, with four unchanged
Ubuntu runner classes and a global two-worker limit per job.

| Revision / cache state | Job span | Complete feedback metadata | Aggregate runner time |
| --- | ---: | ---: | ---: |
| Checkpoint `be87dae`, fetched API snapshot | 93 s | 96 s | 323 s |
| Bundle only, cold dependencies/ripgrep | 140 s | 142 s | 397 s |
| Bundle only, warm dependencies / one cold ripgrep | 97 s | 101 s | 294 s |
| Bundle + shared queue, warm dependencies / cold ripgrep | 88 s | 92 s | 291 s |
| Bundle + shared queue, all warm | 77 s | 82 s | 262 s |
| Bundle + shared queue, all cold (cache restore/save disabled) | 95 s | 99 s | 323 s |

The fully cold observation is run `39812799535` at `92332e13`: identical
functional code, with dependency/ripgrep cache steps disabled for this one run.
All 486 cases passed with the two existing skips. Shared caches were neither
deleted nor rewritten. Normal cache conditions are restored in the retained
workflow, and the temporary experimental-branch trigger is removed. This measures
fresh hosted setup honestly without adding a permanent cache-bypass mechanism.

Complete feedback uses workflow creation for push runs and `run_started_at` for
reruns, through terminal workflow `updated_at`; job span uses first job start
through last job completion. Queue, setup, build, test, cleanup and publication
metadata are included. There is no separate GitHub publication timestamp, so these
are bounded observations, not an exact UI notification measurement. Raw API and
logs are retained in adjacent JSON files, including failed and slower experiments.

The all-warm candidate's build-plus-test stages used 284.06 CPU-seconds total
(user + system), versus 289.18 in the preceding mixed-cache run; hosted-runner
variance remains material. These CPU totals exclude setup processes; the aggregate
job-seconds include every phase. Maximum child RSS across build stages was
1,165,760 KB; the largest test-stage RSS was 474,388 KB. E2E/Responses was the
warm critical lane: 48.88 s test stage, 77 s complete job. This is evidence for
retaining the different architecture, not evidence that a 60-second goal is met.

## Correctness and tradeoffs

All assertions, cases, deadlines and source/built E2E entry-point coverage remain
unchanged. Integration's CI CLI launchers and provider cases exercise the freshly
built production artifact. Standalone integration still builds its own artifact.
The queue retains each tier's setup and file isolation. All 63 discovered files
are assigned exactly once; explicit include override is essential.

Independent verification accepted the exact functional code `f684903f`:

- Temporary assertion, collection and unhandled-rejection faults all returned
  exit 1 while other assigned files completed; unassigned files stayed excluded.
- Six files used six fresh processes, distinct application caches, separate
  project bytecode caches, and a maximum of two active workers. Teardown removed
  the caches. No inter-project build mutation was found.
- A real final bundler failure restored the previous build byte-for-byte and
  returned failure; the restored executable still worked.
- A fresh exact-commit build packed and relocated to a path containing spaces and
  `#` passed direct executable help/version in unset, test and production modes.
  React initialization modes and version were correct; the tarball omitted source
  and build scripts. Dependency installation was reused for this relocation probe.
- A source-map offset defect was reproduced, fixed and rechecked: replacing the
  nested shebang with a blank line preserves original stack line 3:7.

The final packed artifact is 8,095,188 bytes; unpacked files are 42,054,719 bytes,
including a 27,972,160-byte bundle (9,822,645 bytes of maps). This costs package
size because emitted modules remain for worker entry points, assets and public
deep imports. The 35.9% reduction from the first bundled archive removes duplicate
embedded source content, not executable code or verification. Bundle build cost
was 5.27–6.48 s per entire production build in the all-warm run, included above.

Typecheck, lint (31 pre-existing warnings), build, the no-unit-tests policy and
every required CI tier passed. No permanent tests or static guards were added;
the fault probes are preserved as evidence only. Linux/Node24 is verified; this
fresh investigation did not measure Mac or other supported Node/platform pairs.
No paid model calls, additional runner classes/counts, merge or deployment occurred.

## Adoption decision

Retain bundling the shipped CLI and sharing one isolated queue per job. The
measured warm feedback improved from the rechecked checkpoint's 96 s to 82 s,
with aggregate job time 323 s to 262 s; cold feedback was 99 s. These finite
samples justify the improvement and its CPU/startup mechanism, but do **not**
establish a stable one-minute loop. No lower bound is inferred. The next distinct
question is what the Responses/E2E lane spends its low-CPU waiting time on; that
has not been solved by moving cases, adding runners or weakening timeouts here.

PR35's checkpoint `be87dae` remains in ancestry and its evidence remains intact.
Prior writer ownership was explicitly cleared before updating its branch; the
remote head was rechecked unchanged. The parent can compare or revert this
bounded experiment independently of the earlier gains.
