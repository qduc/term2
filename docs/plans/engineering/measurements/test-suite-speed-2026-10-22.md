# Integration and provider test performance (2026-10-22)

A later follow-up on the CLI's own startup time is recorded in
[CLI cold start (2026-11-07)](#cli-cold-start-2026-11-07).

## Closeout: faster, one-minute goal not achieved

Further performance experiments stopped at the user's direction. The retained
code at `5a2997bfec981bd965b292cbc58df8ea4752a4c2` passed all four jobs in
[CI run 39801850508](https://github.com/qduc/term2/actions/runs/39801850508).
The documentation/ledger closeout head's checks are linked from
[PR #35](https://github.com/qduc/term2/pull/35); no further performance changes
are part of that closeout.

| Run | Runner start → last finish | Creation → last job finish | Total runner-seconds | Cache state |
| --- | ---: | ---: | ---: | --- |
| Baseline `81445c7`, 39788751714 | 172 s | 175 s | 392 | Previous dependency setup |
| First candidate `88b2cc6`, attempt 1 | 109 s | 112 s | 426 | All dependency caches cold |
| Same-head attempt 2 | 84 s | 86 s | 308 | Mixed Node patches; two dependency hits, two misses |
| Retained code `5a2997bf`, 39801850508 | **91 s** | **94 s** | **299** | Four dependency hits; one rg hit, one image-specific rg miss |

Queue-to-first-runner time was 3, 3, 2 and 3 seconds respectively. These intervals
include checkout, dependencies, builds, all tests, cache post-processing and
cleanup. The retained run cut runner-span elapsed time by 47.1% and aggregate
runner time by 23.7% relative to the baseline, with the same four runners and
two workers each. The first cold candidate instead increased aggregate work
by 8.7%; that counterexample remains recorded. These are individual hosted-runner
samples, not a guarantee or a clean causal estimate of every component.

Workflow success `updated_at` was 192 seconds after creation for the baseline
and 104 seconds for the retained code. Earlier candidates showed delayed status
publication (610 and 598 seconds) despite much earlier completed job logs.
`updated_at` is mutable metadata rather than a dedicated finish timestamp; it
is retained separately so runner completion is not misrepresented as immediate
published feedback. The approximately **60-second complete-feedback goal was
not achieved**, including on the final verified code. Its provider invocation
alone took 60.96 seconds before setup and cleanup.

Coverage is unchanged: **28 guards, 204 integration + 1 skip, 222 provider +
1 skip, and 32 E2E**: 486 passes and two existing skips across 488 cases, assigned
once across 63 files. Cases, assertions, deadlines, retries, skip conditions
and file isolation remain. The retained CLI partition passed all 53 cases in
28.22 s and 24.54 s in two complete Linux runs. The earlier failed three-entry
cloud partition remains rejected; the retained two-entry implementation has
fresh complete CI evidence. No new permanent unit tests were introduced.

Typecheck, build, lint (31 existing warnings), formatting, no-unit-tests, AST
preservation, inventory and failure-path checks passed. The Mac failures below
remain visible and were never converted into skips. The final assignment and
setup are retained; all earlier slower or unsuccessful experiments remain in
[the machine-readable evidence](./test-suite-speed-2026-10-22.ci-loop.json).
Two historical per-job summaries still lacked terminal metadata even though
their workflows reported success and complete logs passed. Their exact job
completion/cost values are left unknown; no timestamps were invented. The
retained code's four job timestamps and conclusions are complete.

The shared Mac checkout and its three unrelated files remain unchanged. No
merge, deployment, paid-provider run, extra runner or expanded access occurred.
The following sections preserve the chronological investigation and its limits.

Measured against main `31bf8380137d7f48f463e54f31570a3f3026b4fc`
(v0.35.0), in an isolated worktree. All providers were local HTTP/SSE/WS
fixtures. No paid provider calls were made.

The sections below retain the original local measurements and failures. The
subsequent [CI run 39741934129](https://github.com/qduc/term2/actions/runs/39741934129)
at PR head `7d9a90114b05e170dc85c06fd67ecf8ddef02816` passed all four jobs:
guards, integration (204 passed / 1 skipped), E2E, and provider (222 passed /
1 skipped). Its Vitest durations were 64.96 s for integration and 149.61 s for
provider. That runner used Node 24.22.0 and pnpm 11.7.0; it is not directly
comparable to the local environment below. This CI result was rechecked before
the follow-up optimization, with both the PR head and main unchanged.

The retained provider split at `c12690edd65c205099ed2f982ba59b22828c594c`
also passed all four jobs in [CI run 39784356168](https://github.com/qduc/term2/actions/runs/39784356168):
28 guards, 204 integration cases plus one existing skip, 222 provider cases plus
one existing skip, and 32 E2E cases. The Mac continuation below independently
checked these job results and logs, repeated the Responses comparison, and ran
the complete integration inventory against main. Earlier failures remain below.

## Changes and coverage

- Compile the integration CLI once in global setup, using the same native
  TypeScript compiler/configuration as the previous CLI and gateway helpers.
  CLI, gateway and ACP tests share emitted code, with separate processes,
  homes, settings, mock servers and persisted state. ACP's package-version
  assertion remains; its old reason for using `tsx` was obsolete because
  installation-version resolution now walks up to the package root.
- Prime one disposable Node compile cache per invocation using an isolated
  `--help` process before starting workers. This shares V8 bytecode, not module
  instances or application state. Teardown removes it. Node <22, V8 coverage,
  and `NODE_DISABLE_COMPILE_CACHE=1` skip it. Global setup errors fail the run.
- Reevaluate PTY predicates every 20 ms as well as on terminal events, and
  once at the timeout boundary. HTTP arrivals do not necessarily produce PTY
  events. Success, errors, exit and timeout all remove the interval/listeners.
- Bound integration CI workers to two, since each worker may also start a real
  CLI or index process. Module isolation remains enabled.

No existing scenario, assertion, test deadline, fixture deadline, bail behavior,
or skip condition was removed or relaxed. Integration retains 205 cases in 22
files. Provider retains every original case and adds one process/HTTP regression
case (222 to 223 cases, still 25 files). This is test infrastructure only.

## Environment and method

Linux x86_64, kernel 6.18.55; Intel Xeon Platinum 8573C; five visible CPUs,
cgroup CPU quota four cores (`cpu.max = 400000 100000`), memory limit 16 GiB.
Node 24.19.0, pnpm 11.19.0, Vitest 4.1.9. CI mode was explicit. Runs were
sequential; no lint, build, profiling or other suite was run concurrently with
a measured suite. Physical-host contention was not controlled.

Common environment for suite runs:

```sh
export PATH=/workspace/.local/usr/bin:$PATH
export XDG_CACHE_HOME=/workspace/.cache
export XDG_DATA_HOME=/workspace/.local/share
export npm_config_store_dir=/workspace/.cache/pnpm-store
export pnpm_config_verify_deps_before_run=
export CI=1
export NODE_ENV=test
```

The pnpm override prevents automatic dependency relinking during a timing run;
dependencies were already installed with the frozen lockfile in this worktree.
Initial setup failures and an automatic relink/build warmup are excluded from
performance comparisons. Their logs remain in `/tmp/term2-install*.log` and
`/tmp/term2-before-provider-cold*.log` in the execution environment.

Wall times include the command's setup/teardown and use Python
`time.monotonic()` around `subprocess.run(..., timeout=900)`. CPU times use
`resource.getrusage(RUSAGE_CHILDREN)`. Provider timing commands intentionally
omit bail to execute the complete inventory despite baseline failures. The
published fail-fast command remains unchanged. The CLI had already been built
for provider-only timing; build cost is separate.

```sh
pnpm test:integration
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  --reporter=verbose --reporter=json \
  --outputFile.json=/tmp/term2-before-provider-results.json
```

Use an `after` output filename for the candidate provider run. The final
integration run appends `--reporter=verbose --reporter=json
--outputFile.json=/tmp/term2-after-integration-results.json` to the integration
command for progress and case accounting.

## Full-suite observations

The initial integration comparison had cold emitted CLI caches on both sides
(two private builds before, one new shared build after). The later CI-worker
trial used a warm emitted build. Every candidate invocation used a fresh
bytecode directory and included the priming process. OS/dependency caches were
not reset.

These are single full-suite observations with failures, not a clean passing
benchmark or a stable percentage-speedup guarantee. Failure membership changes
between runs. Lower elapsed times must be read alongside counts; they cannot
alone establish equal successful work. Passing representative comparisons and
the regression checks below are the narrower correctness/performance evidence.

| Run | Wall | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Main integration, cold emitted builds | 462.64 s | 188 | 16 | 1 |
| Shared build/cache, original worker count | 403.01 s | 193 | 11 | 1 |
| Candidate integration, two CI workers, warm emitted build | 375.57 s | 196 | 8 | 1 |
| Main provider, complete inventory | 519.60 s | 203 | 18 | 1 |
| Candidate provider, complete inventory | 444.33 s | 208 | 14 | 1 |

The observed reductions against the initial main runs are 75.27 s (14.5%) for
provider and 87.06 s (18.8%) for the final integration run. The latter also
changes the worker limit and emitted-build cache condition. Neither percentage
is a claim about a stable, equally passing suite.

The provider inventory comparison found zero missing original case names and
exactly the new harness regression. The repeated-questions case failed before
at 48.17 s (40 s PTY wait) and passed after in 11.41 s. Its assertions and number
key selection were unchanged. This supports the synchronization repair; it does
not prove the historical GitHub timeout had no other contributing cause.

## Attribution and regression evidence

An isolated built CLI `--help` CPU profile took 6.77 s. The largest individual
sampled cost was `compileSourceTextModule` (1.218 s), followed by garbage
collection (0.346 s), CommonJS compilation (`wrapSafe`, 0.337 s), and Zod schema
initialization (0.283 s). Module stat/realpath/load work was also visible. The
profile is `/tmp/term2-startup.cpuprofile`; profiling was separate from acceptance
runs. A first probe was 6.72 s uncached versus 3.46 s with a warm compile cache;
priming took 5.66 s and must be amortized across a suite.

The new regression starts a real PTY child, waits for readiness, sends input,
and captures the child's HTTP request without subsequent output. On the old
harness it fails with a 1000 ms state timeout even though HTTP arrived. After
the fix it observes that request and separately proves an unmet request count
still times out. The focused harness plus repeated-question run passed 19/19.

```sh
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/provider-test-harness.test.ts \
  -t 'observes HTTP arrivals'
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/provider-test-harness.test.ts \
  scripts/provider-black-box/turn-decisions.blackbox.ts
```

The first command was run before the harness fix and failed (exit 1). The second
passed after it. No deadline was increased and no Enter key was added.

## Bounded passing comparisons and failed attempts

On the final implementation, switch only `NODE_DISABLE_COMPILE_CACHE=1` (off)
versus unset (on), keeping one worker, the same warm emitted CLI, isolated
per-test homes, and unchanged assertions. Each on invocation has a fresh cache
and includes priming. One fully passing pair was obtained for each workload:

| Selected workload | Cases | Cache off | Cache on |
| --- | ---: | ---: | ---: |
| Headless instructions across all seven profiles | 7 | 40.88 s | 36.03 s |
| Reference approval across full/bare and three advice outcomes | 6 | 69.31 s | 29.22 s |

```sh
# Off: prefix either command with NODE_DISABLE_COMPILE_CACHE=1.
# On: leave that variable unset. Keep NODE_ENV=test and the common environment.
pnpm exec vitest run --config vitest.integration.config.ts \
  source/cli.integration.test.ts -t 'has unattended instructions' \
  --maxWorkers=1 --reporter=json --outputFile=/tmp/integration-representative.json
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/reference-approval.blackbox.ts \
  -t 'reference approval preserves' \
  --maxWorkers=1 --reporter=json --outputFile=/tmp/provider-representative.json
```

These are **single passing pairs**, not repeated proof: a second cached
integration observation took 61.63 s and timed out in the `pair` profile at
10.08 s (6 passed, 1 failed). The comparison stopped there. A preliminary
10-case provider selection also failed its uncached terminal-only case at the
existing 15 s deadline (9 passed, 1 failed, 75.42 s); that attempt was retained
and rejected as a clean benchmark. It was not silently dropped from a median.
The narrower approval workload above is a separately named comparison. No
scenario was excluded from either full-suite run.

Large variability and failed samples preclude a reliable percentile, spread,
or stable suite speedup claim on this host. The results support a bounded
compile/setup optimization and the missed-wakeup repair; they do not establish
a clean green baseline.

## Remaining-failure isolation

The final full integration run failed seven CLI cases and one provider-menu
case, all at deadlines. All eight passed in a subsequent one-worker,
cache-disabled run (76.83 s wall, 68.11 s Vitest duration). The earlier repair
deadline and index-corruption cases passed in the two-worker full run.

Five provider cases passed on main but timed out only in the candidate full
observation: Codex incomplete HTTP, Anthropic incomplete, Google incomplete,
OpenAI HTTP reasoning and Codex HTTP reasoning. All five passed together with
one worker and cache disabled, at their unchanged deadlines. The provider-error
CLI case still failed in that run (5 passed, 1 failed; 44.20 s wall). It also
failed on main. Nine of the final provider failures overlap main's failures;
the other five have this isolated passing evidence. This is consistent with
contention-sensitive deadlines, not proof that every failure is unrelated to
the change. Remaining full-suite failures require a healthy-runner check before
merge; no timeout was enlarged to make them disappear.

The isolated commands were:

```sh
NODE_DISABLE_COMPILE_CACHE=1 pnpm exec vitest run \
  --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/provider-session-resilience.blackbox.ts \
  scripts/provider-black-box/provider-cli.blackbox.ts --maxWorkers=1 \
  -t 'codex-http.incomplete|runtime-anthropic-messages.incomplete|runtime-google-generate-content.incomplete|openai-http.reasoning|codex-http.reasoning|reports provider errors' \
  --reporter=verbose
NODE_DISABLE_COMPILE_CACHE=1 pnpm exec vitest run \
  --config vitest.integration.config.ts source/cli.integration.test.ts \
  source/providers/provider-presets.integration.test.tsx --maxWorkers=1 \
  -t 'goal flags before startup|interactive launch persists|positional launch durably|resume preserves the replayed goal|advertised -h and -v|--resume ls prints|session-only when resolution|copies inventory defaults' \
  --reporter=verbose
```

## Timing wrapper

The temporary wrapper used for each measured command (pass a unique label,
then the command and arguments) was:

```python
import json, resource, subprocess, sys, time
label, *command = sys.argv[1:]
start = time.monotonic()
with open('/tmp/term2-' + label + '.log', 'w') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=900)
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
data = dict(command=command, elapsed=time.monotonic()-start,
            user=usage.ru_utime, system=usage.ru_stime,
            maxrss=usage.ru_maxrss, exit=result.returncode)
with open('/tmp/term2-' + label + '.json', 'w') as out:
    json.dump(data, out)
print(json.dumps(data), flush=True)
sys.exit(result.returncode)
```

## Verification and remaining limits

Typecheck, full lint (31 warnings, no errors), 28 static guard assertions, and
the no-unit-tests check passed. The final `pnpm build` passed. The sequential
E2E run (`pnpm test:e2e --reporter=verbose`) had 31 passed and one failed:
fake-Codex's retained-socket stale-anchor case exceeded its first-frame watchdog.
`pnpm test:codex-network --maxWorkers=1` then passed all 16 protocol cases.
The full E2E result remains a failure; an isolated pass is not a full-suite pass.

An earlier E2E attempt was invalidated by my launching it alongside the build:
one built-worker module was temporarily absent while `dist` was replaced. That
attempt had 30 passed and two failed and remains in `/tmp/term2-e2e.log`.
The corrected sequential result is `/tmp/term2-e2e-final.log`. No published
performance number includes E2E or concurrent build work.

Full-suite failures are preserved, not converted to skips or accepted as green.
The machine-readable [evidence summary](./test-suite-speed-2026-10-22.results.json)
includes commands, resource measurements, all provider case-name accounting,
failure names, representative attempts, and source hashes. Full local logs and
Vitest JSON reports are `/tmp/term2-*.log` and `/tmp/term2-*-results.json` in the
execution environment. The temporary scripts/profile are not committed.

At the original handoff, remaining blockers were no reproducibly green complete suite on this host, unstable
repeated representative timings, and pending PR CI. No live/paid provider,
Docker-host opt-in, merge, or deployment check was attempted. The ordinary
integration suite retains its existing opt-in Docker skip. Main was fetched
again after validation and remained at the measured baseline commit.

## Follow-up against PR head `7d9a901` (Astra)

The follow-up keeps a provider scheduling improvement and rejects an integration
scheduling experiment. It does not change application code, provider behavior,
timeouts, assertions, the two-worker limit, or scenario coverage. The previously
implemented integration shared build and compile cache remain.

The Responses scenarios now have three entry files: continuity (9 cases), tools
(11), and failures (14). They register their existing cases from
`provider-session-responses-scenarios.ts`. Default Vitest file isolation gives
each entry its own fixture state and cleanup. Cases within each file remain
sequential. The full provider inventory remains 223 cases, across 27 files.

An experimental CLI partition used options/models (26), durable goals (7), and
headless behavior (20). It was reverted because the passing representative
baseline was followed by two candidate runs with timeouts. The final CLI test
file is byte-for-byte identical to `7d9a901`; integration remains 205 cases in
22 files. The rejected patch is archived in
`/tmp/term2-astra-rejected-integration`, with all its measurements retained.

### Limiting mechanism and rejected hypothesis

The prior passing CI run spent 147.05 s in the serial Responses file out of
149.61 s total Vitest duration. Resilience accounted for another 48.08 s of
test work; total test work was 259.16 s. Dividing the long Responses file lets
the existing two workers share that work. It does not increase worker count
or run scenarios concurrently within a fixture instance.

Three Codex WebSocket cases in that CI run each took about 32 s. A local
native-error case also took 33.46 s, but a bounded three-case diagnostic did
not establish a teardown defect: all three passed and total cleanup took
27.0, 18.7, and 207.9 ms. The diagnostic took 47.77 s, including setup. Its
temporary tracing was removed; no speculative socket or timeout repair was
kept. These variable case timings are not attributed to a confirmed cause.

### Comparable workload observations

The follow-up used the same local environment and timing wrapper described
above. Every measured run used `CI=1`, `NODE_ENV=test`, `--maxWorkers=2`, and a
fresh disposable Node compile cache including its normal priming. The provider
used the same already-built `dist/` throughout. Integration used a warm emitted
build on both sides; the native incremental compiler was explicitly run outside
timing after adding the experimental helper. No benchmark, build, or lint run
overlapped another benchmark. A 4.6 s AST comparison did overlap the full CLI
baseline; that observation is qualified further for this reason.

| Selected complete workload | Before wall | Candidate wall | Before passed/failed | Candidate passed/failed | Decision |
| --- | ---: | ---: | --- | --- | --- |
| Responses, all 34 cases | 436.42 s | 243.09 s | 34 / 0 | 34 / 0 | Keep provider partition for full CI |
| CLI, all 53 cases | 231.80 s | 187.06 s | 52 / 1 | 51 / 2 | Reject CLI partition |

The Responses pair observed 193.33 s (44.3%) less elapsed time. This is one
passing pair for the affected workload, not repeated proof or a whole-provider
suite speedup guarantee. The CLI pair does not establish an equally passing
improvement. Its baseline timed out in goal-flag validation; the candidate timed
out in generic model listing and bare unsupported-workspace completion.

A separately defined nine-case CLI workload spanned all three experimental
groups: help, aliases, unknown flags, achieved-goal completion, both verifier
models, both bare-profile settings, and full unsupported-workspace completion.
The planned before/after/after/before sequence stopped after two failed
candidate samples:

| Sample | Wall | Passed | Failed |
| --- | ---: | ---: | ---: |
| Before 1 | 58.17 s | 9 | 0 |
| Candidate 1 | 82.39 s | 8 | 1 |
| Candidate 2 | 71.66 s | 5 | 4 |
| Before 2 | Not run after the failure budget was reached | — | — |

Candidate 1 timed out in aliases. Candidate 2 timed out in aliases, achieved-goal
completion, and both bare-profile settings. No sample was discarded from a
median and no passing integration speedup is claimed. Host variation and
additional child-process contention are plausible contributors; the evidence
does not establish that these failures are unrelated to the experimental split.
Rejecting that split avoids adopting the observed reliability risk.

### Exact commands and preservation checks

The timing commands, per-case names/statuses/durations, failed attempts, warmup
history, baseline blobs, and source hashes are in the
[follow-up evidence](./test-suite-speed-2026-10-22.follow-up.json). Raw logs and
Vitest JSON remain under `/tmp/term2-astra-*` in the execution environment.
The baseline commands targeted the original files at `7d9a901`; the provider
candidate selected all three entries:

```sh
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/provider-session-responses.blackbox.ts \
  --maxWorkers=2 --reporter=verbose --reporter=json \
  --outputFile.json=/tmp/term2-astra-responses-baseline-1-results.json
pnpm exec vitest run --config vitest.provider-black-box.config.ts \
  scripts/provider-black-box/provider-session-responses.blackbox.ts \
  scripts/provider-black-box/provider-session-responses-tools.blackbox.ts \
  scripts/provider-black-box/provider-session-responses-failures.blackbox.ts \
  --maxWorkers=2 --reporter=verbose --reporter=json \
  --outputFile.json=/tmp/term2-astra-responses-candidate-1-results.json
```

CPU values from `RUSAGE_CHILDREN` exclude some reparented PTY grandchildren.
They must not be used to infer that wall time is mostly waiting. Wall timing
and actual case results are the comparison metrics here.

An independent rerun of the normalized TypeScript AST comparison confirmed
all 13 provider registrations, 29 fixture functions, and the cleanup hook are
unchanged. Runtime reports preserve all 34 case names. The same comparison
also preserved the experimental CLI's 42 declarations, 9 helpers, and lifecycle
hooks before that experiment was rejected. Original snapshots were independently
matched to their `7d9a901` Git blobs.

Typecheck, full lint (31 existing warnings, no errors), the no-unit-tests check,
and the independent preservation/diff checks passed on the complete experimental
candidate. A first guard run had 27 passes and one 10 s core-import timeout while
lint and typecheck ran concurrently. A subsequent sequential run passed all
28 assertions in seven files (8.51 s Vitest). Both logs are retained. Full
integration, provider, and E2E verification of the retained patch subsequently
passed in CI run 39784356168 at `c12690e`, as recorded above. Its Vitest durations
were 75.50 s for integration, 80.00 s for provider, 7.81 s for E2E, and 2.29 s
for guards. Separate CI runs have uncontrolled host variation; these durations
are verification evidence, not a paired performance estimate. No paid provider,
Docker opt-in, merge, or deployment was run.

## Mac continuation and repeated comparison

The cloud executor stopped before local work began. The fetched branch matched
`c12690edd65c205099ed2f982ba59b22828c594c`. A private clone and three isolated
worktrees kept the shared checkout, its three unrelated changed/untracked files,
and its existing worktrees untouched. Each worktree had its own frozen-lockfile
installation; no `node_modules` symlinks were used.

The host was macOS 26.6.2 arm64, Apple M4 Pro, 12 logical CPUs, 48 GiB RAM,
Node 24.16.0, pnpm 11.7.0, and Vitest 4.1.9. Every measurement used `CI=1`,
`NODE_ENV=test`, and two workers. Measured suites ran sequentially without other
task-owned builds, lint, or tests. Other user workloads were not controlled;
per-run load averages are retained. These Mac results are separate from the
Linux observations above.

### Responses: retain the provider split

The baseline was `7d9a901`; the candidate was `c12690e`. Both used separately
built, identical production code and dependencies, with warm emitted CLI files.
Every invocation included normal setup, a fresh disposable bytecode cache and
its priming process. The comparison selected all 34 Responses cases, with no
bail, filtering, assertion changes, or deadline changes.

The first pair used the Mac's inherited `TMPDIR`, whose `/var/...` spelling
differs from its canonical `/private/var/...` spelling. Both variants failed
the same existing `session_search` fallback assertion (33 passed / 1 failed;
48.19 s baseline and 30.37 s candidate). The fixture saved `projectPath: root`,
while the child searched the canonical path. Changing only `TMPDIR` to the
canonical spelling of the same directory made the focused unchanged baseline
case pass. That diagnostic selected one case; it was not a performance sample.

All subsequent complete runs used that canonical directory on both sides:

| Order | Variant | Wall | Passed / failed |
| --- | --- | ---: | --- |
| 1 | Baseline | 46.29 s | 34 / 0 |
| 2 | Candidate | 29.77 s | 34 / 0 |
| 3 | Candidate | 29.73 s | 34 / 0 |
| 4 | Baseline | 46.76 s | 34 / 0 |

The two-sample means were **46.53 s → 29.75 s**, a 16.78 s (36.1%) reduction
for this workload on this Mac. The baseline range was 46.29–46.76 s and the
candidate range 29.73–29.77 s. This supports retaining the split; it does not
estimate whole-provider-suite performance or establish a cross-platform speed
ratio. The inherited-path failures remain recorded and are not fixed by this PR.

A fresh normalized TypeScript AST comparison independently matched all 13
original test registrations, 29 helper functions, and the cleanup hook. All
four retained source hashes matched the cloud checkpoint. All six complete
Responses runs preserved exactly the same 34 case names.

Mac typecheck, full lint (31 existing warnings, no errors), the no-unit-tests
guard, and diff whitespace checks passed. This continuation changed only the
report, evidence, and task ledger; the measured application and test code stayed
at `c12690e`.

### Integration: preserve the limits, add no further change

The complete integration comparison used main `31bf8380` and candidate
`c12690e`, both with two workers and the same canonical `TMPDIR`. Emitted CLI
cache directories were absent before each run. Default setup, compilation,
candidate bytecode-cache priming, and teardown were included in elapsed time.

| Variant | Wall | Passed | Failed | Existing skips |
| --- | ---: | ---: | ---: | ---: |
| Main | 38.29 s | 197 | 7 | 1 |
| Candidate | 34.17 s | 197 | 7 | 1 |

All 205 case identities and all seven failing case names matched. Failures were
two durable-goal verifier database-path assertions, the ACP backend list/resume
journey, three gateway runtime binding cases, and the gateway pairing socket.
The goal assertions assume a Linux `.local/share` path; the runtime fixtures use
hard-coded `/tmp` roots that fail the canonical-root check on this Mac; the
pairing failure reported `listen EINVAL` at the long temporary socket path.
The ACP failure's cause was not diagnosed. None was converted into a skip.

These failed complete runs do not establish a passing full-suite speedup.
The earlier shared-build/cache work remains backed by passing Linux CI; the
rejected integration partition stays reverted. No additional source-code
optimization or Mac-specific test repair was adopted during this continuation.

Exact commands, environment overrides, timestamps, every case result and
failure, raw-log hashes, CI evidence, and preservation hashes are in
[Mac evidence](./test-suite-speed-2026-10-22.mac.json). Raw local logs, Vitest JSON,
and measurement records remain under
`/Users/qduc/Documents/Codex/2026-10-22/task/evidence/`; the bounded measurement
and AST-check scripts are beside that directory. The cloud's `/tmp` paths above
refer to its original environment and are not available on the Mac. The
committed cloud evidence and GitHub logs were sufficient for this continuation.

## Complete CI feedback follow-up

The goal is approximately 60 seconds including setup and cleanup, using the same
four `ubuntu-latest` runners and two Vitest workers per runner. The baseline
[`81445c7` run](https://github.com/qduc/term2/actions/runs/39788751714) passed all
four jobs in 172 seconds from first job start to last job completion. Its
provider step took about 128 seconds and dependency installation 31 seconds;
the integration step took 76 seconds. These Linux observations are separate
from the Mac measurements.

This bounded candidate redistributes existing files across the four jobs,
including moving CLI integration to the guard runner and provider work to the
E2E and integration runners. The 65-second resilience file is separated into
transport and continuity entries with unchanged scenario registrations,
helpers and cleanup. Discovery uses each real tier configuration and assigns
all 62 files exactly once. New files receive a default owner. Each tier retains
its configuration, worker cap, isolation and failure policy; failures remain
nonzero and do not suppress subsequent tiers within a job. Published local
suite commands are unchanged.

An exact-key installed-dependency cache includes native addons. The key covers
OS/image, architecture, resolved Node version, pnpm version, manifests, lockfile,
workspace build policy and vendored packages. Frozen installation still runs;
SQLite and SSH native loads are checked after restore. Generated `.cache` and
Vite state are excluded, and `dist` is outside the cached paths. Setup checks
that integration's emitted CLI and `dist` are absent before the current-source
build. This prevents restored JS or prompts from surviving source deletions.
Cache restore/save and builds remain inside the measured CI interval. A cold
cache is expected to be slower; it is not omitted from the experiment.

The comparable full-provider Mac runs took 66.15 and 64.00 seconds, each with
217 passes, the same five failures and one existing skip (223 identical case
identities/outcomes). These failed runs do not establish a passing full-suite
speedup. They also do not measure the distributed CI layout. AST checks matched
all 11 resilience test registrations, 49 helpers and the cleanup hook.
Typecheck, ESLint (31 existing warnings), formatting, and the no-unit-tests
guard passed. A temporary failure-injection check confirmed later tiers still
run and the script exits nonzero after an earlier failure.

### Complete-CI measurements

The first candidate, `88b2cc6`, passed all four jobs in
[run 39794433963, attempt 1](https://github.com/qduc/term2/actions/runs/39794433963/attempts/1):
486 passes and the same two skips across all 488 cases. All four dependency
caches missed. First job start to last completion was **109 seconds**, down
from 172 seconds (36.6%); run creation to last completion was **112 seconds**,
including three seconds before the first job. Setup, builds, native compilation,
cache saving and cleanup are included. Summed runner time increased from
392 to 426 seconds in this cold sample (8.7%); the runner count and peak worker
cap stayed unchanged. These are individual observations, not a stable guarantee.

The same-head repeat selected Node 24.21.0, 24.22.0 and 24.22.1 on different
hosted images. Two jobs restored the cache and verified dependencies in under
one second, while two correctly missed the cache after the Node change. This
is not a controlled all-warm comparison. Native addon checks and the checks
for absent generated CLI/dist output passed after restoration.

The setup follow-up pins Node to the baseline's 24.21.0 and first attempts
ripgrep installation using the hosted image's existing apt index. It refreshes
the index and retries only on failure. A temporary subprocess probe checked
successful installation, stale-index recovery, update failure and final install
failure; final failures remain nonzero. This targets the observed 8–12 seconds
of unconditional apt update/install without changing test deadlines or cases.

At this intermediate checkpoint the one-minute goal was unverified. The cold CLI integration invocation
alone took 63.04 seconds; the same-head repeat took 50.63 seconds. Its 53 cases
remain sequential. The previously unreliable integration partition remains
rejected. Full metadata, local outcomes, source hashes, preservation checks,
and rejected attempts are in [CI loop evidence](./test-suite-speed-2026-10-22.ci-loop.json).


### Second bounded scheduling experiment

The pinned-runtime run restored all four dependency caches and verified native
addons and fresh build inputs, but one runner spent 50.94 seconds installing
ripgrep (34 seconds downloading 1.55 MB). The complete logs retain every passing
case. The follow-up caches only the ripgrep executable under an OS, architecture
and exact hosted-image-version key, verifies it with `--version`, and puts its
directory on the test PATH. Cold installation retains the visible apt fallback.
A temporary probe verified copying the existing executable, using the cache
without a system `rg`, and propagating failure from a corrupt executable.

The sequential CLI invocation also took 63.19 seconds. A new two-entry CLI
experiment divides the existing registrations into startup and headless groups.
It is distinct from the earlier rejected three-entry cloud experiment, which
remains recorded above. Each entry has its own isolated fixture module and
cleanup; tests stay sequential within each file. The shared registration module
is excluded from production emission and keeps the original test lint policy.
A full emitted-file comparison matched 3,451 files byte-for-byte; only generated
`build-info.json` differed because it records the commit. No test registration
module was emitted. All 42 registration ASTs, nine helpers and two hooks matched.

Comparable Mac runs covered all 53 CLI cases with cold emitted builds, fresh
V8 cache priming and two workers: **29.61 → 19.14 seconds**, both 51 passes and
the same two durable-goal database-path failures. These failed runs support
preserved local outcomes, not a passing speedup claim. At this point the experiment still
required complete Ubuntu CI before adoption; the passing results are recorded below.

The four jobs now assign all 63 files exactly once: guards, the two CLI files
and safety/approval provider files on `test`; the other integration files on
`integration`; E2E, Responses, stateless and provider CLI files on `e2e`; all
remaining provider files on `provider-black-box`. Each job retains two workers.
The integration job no longer builds an unused `dist`; its normal global setup
still compiles the shared integration CLI. No scenarios, assertions, deadlines,
retries, skip conditions or isolation settings were changed. Local typecheck,
build, lint (31 existing warnings), formatting, inventory, failure propagation
and no-unit-tests checks passed.


The complete [two-entry run at `d396a438`](https://github.com/qduc/term2/actions/runs/39800460034)
reported workflow success. All 488 cases are accounted for: 486 passed and the
same two skipped. The 53 CLI cases passed in **28.22 seconds**, versus 63.19
seconds in the preceding pinned-Node run. This supplies the passing Ubuntu
evidence that the earlier cloud partition lacked; the earlier failed experiment
is still retained, and this is not a claim about passing Mac integration.

That run exposed a new imbalance: E2E's two invocations took 13.18 and 66.06
seconds while integration and provider invocations took 28.08 and 31.83 seconds.
The final assignment moves the stateless provider file back to integration and
the provider-CLI file back to provider-black-box. E2E keeps its original cases
and the three Responses files; safety and approval provider cases remain with
guards and the two CLI integration files. Integration again needs its `dist`
build for the stateless provider file. The worker and runner limits stay fixed.
All 63 files still occur exactly once, and an injected tier failure still makes
the job fail while allowing later tiers to execute.

For completeness, the earlier same-head repeat is now reconciled: 84 seconds
from first job start to last completion, 86 seconds from attempt creation,
308 summed runner-seconds, all 488 cases retained. It mixed Node versions and
cache hits/misses and is not an all-warm measurement. The pinned setup run and
two-entry run exposed individual job summaries lagging fully completed logs
even after their workflows reported success. No retry or cancellation was made
because of that inconsistency. Raw timestamps and snapshots are retained;
mutable workflow `updated_at` values are recorded separately from job elapsed
time. The approximately one-minute complete feedback target was not achieved;
see the closeout above for the final verified measurements.

## CLI cold start (2026-11-07)

A follow-up at the user's request: shorten the built CLI's time to an idle
composer. Every e2e launch pays it, and so does every user start. Measured on an
idle 4-vCPU Linux container (load average below 1), base `7020c91` against the
candidate on branch `claude/sweet-hamilton-igj0w0`, each built with
`scripts/build.mjs` in its own checkout. Node 24.21.0 is the version CI's
`setup-tests` installs; the container's own Node 22.23.4 was used for the
profiling and the first measurements, and gave the same picture.

### Method

- **Time to idle:** from spawn until the application writes its harness idle
  marker (`TERM2_HARNESS_IDLE_PATH`; the first transition to composer-owned idle),
  under the same Python PTY bridge as `tests/helpers/terminal-e2e.ts`, with
  `--profile bare` and the closed-loopback provider of `writeMockCliSettings`.
  Base and candidate runs alternate. Each build gets its own compile cache, primed
  with `--help` and one discarded launch, as `tests/helpers/cli-compile-cache.ts`
  primes the suites.
- **Attribution:** `node --cpu-prof --cpu-prof-interval=200` on PTY launches,
  and a copy of each bundle whose esbuild `__esm`/`__commonJS` helpers record every
  module's initialization window. Exclusive init time includes V8's lazy
  compilation of the init function, which the profile otherwise charges to `__init`.
- The harness, profilers and probes were temporary scratch scripts; none is
  committed.

### Results

Medians (p25–p75) of interleaved runs, Node 24.21.0:

| Condition | n | Base | Candidate | Change |
| --- | ---: | ---: | ---: | ---: |
| E2E conditions: `dist/src/app/cli.js`, `NODE_ENV=test`, warm `NODE_COMPILE_CACHE`, PTY never answers terminal queries | 25 | 707 ms (690–725) | 457 ms (445–474) | −35% |
| `--help`, same conditions | 25 | 338 ms | 165 ms | −51% |
| Installed `term2` (`dist/cli.js`), `NODE_ENV` unset, no `NODE_COMPILE_CACHE`, one `TERM2_CACHE_DIR` for all runs (the candidate's own cache, warm after the first launch), PTY answers OSC 11/DA1 at once like a local terminal | 20 | 690 ms (671–700) | 473 ms (458–491) | −31% |
| Same, PTY never answers | 20 | 824 ms (807–829) | 455 ms (441–467) | −45% |
| `--help` through `dist/cli.js` | 20 | 472 ms | 167 ms | −65% |

The same five rows on Node 22.23.4: 701 → 444 ms (−37%), 342 → 162 ms,
679 → 445 ms, 830 → 441 ms and 471 → 162 ms. On a first start, with no compile
cache for either build, the independent verifier measured 967 → 750 ms (n=5,
Node 24, never-answering PTY).

`node scripts/run-ci-lane.mjs e2e` passed 199 of 199 cases in 39 files on every
run below; nothing else ran on the box.

| e2e lane | Base | Candidate | Change |
| --- | ---: | ---: | ---: |
| Node 24.21.0, alternating base, candidate, base, candidate: Vitest duration | 163.54 s, 161.79 s | 130.95 s, 134.61 s | −18% |
| Same runs, summed case time | 466.7 s, 462.1 s | 375.0 s, 385.5 s | −18% |
| Node 22.23.4, one run each: Vitest duration | 158.05 s | 133.60 s | −15.5% |

These are local samples, not CI measurements.

The attribution below was profiled on Node 22.23.4. Process start to the first
module initialization fell from 150–175 ms to 97–116 ms (bare Node reaches user
code in about 17 ms). Module initialization
before idle fell from 233 ms over 1,339 modules to 173 ms over 1,284. The entry
bundle shrank from 17.70 MB to 10.98 MB.

### What changed, and what each was worth

Intermediate interleaved comparisons (10–12 runs each, E2E conditions) took the
candidate from 749 to 606, then 529, then 472 ms. The base itself drifted between
701 and 763 ms across sessions, so the per-item figures below come from profiles
and isolated timings, not from subtraction.

1. **The terminal background query overlaps startup.** `runTui` used to send the
   OSC 11/DA1 query after app and session creation and wait for the reply, up to
   its 150 ms timeout. The test PTY never replies, so every e2e launch idled
   149 ms; a local terminal answers in milliseconds, a remote link in one round
   trip. `launch-tui-terminal.ts` now sends it, after the home-directory prompt,
   before the TUI's modules load; `runTui` reads the answer just before Ink
   renders. A first version that sent it at the top of `launchTui` still idled
   72 ms, because most of the work it could hide is the TUI's own module
   initialization. Overlap lets startup keep the event loop busy past the timer
   while a reply waits, and libuv runs due timers before it polls input, so the
   timer now gives up from `setImmediate`. A PTY that replied after 150–170 ms got
   the light theme with that step and `[?62;22c` typed into the prompt without
   it; the base build leaked at 170 ms. Replies after about 200 ms leak on every
   build, as before.

   The earlier query has two side effects:
   - An interactive start that fails before Ink renders, such as a refused
     `--ssh` or a failed session creation, has now sent the query. A reply that
     arrives after term2 exits lands in the shell.
   - Between giving up and Ink taking stdin, the terminal is in cooked mode, and
     that window is longer now. A reply that lands in it is echoed as
     `^[]11;rgb:…` rather than typed into the prompt. The base echoed replies at
     160–200 ms the same way.
2. **External packages are no longer imported statically.** The bundle's static
   imports of externals and builtins are linked before any term2 code runs.
   `@anthropic-ai/sandbox-runtime` (about 45 modules, node-forge among them; 50 ms
   alone with a warm cache) now loads with the first sandbox check, and `ssh2`
   (27 ms alone) with the first `SSHService`. Before the runtime has loaded there
   is no per-command state, so cleanup is a no-op and stderr is returned
   unannotated; a runtime that cannot load reports `missing_dependency` instead
   of having crashed startup.
3. **`node:http` is required, not imported.** Node links a builtin through an
   ESM facade that reads every export once, and `node:http`'s `WebSocket`,
   `CloseEvent` and `MessageEvent` exports are getters that load Node's internal
   undici and instantiate llhttp. An ESM import took 18–26 ms against 3–4 ms for
   `require`. `scripts/bundle-entry.mjs` routes the two static imports (OAuth
   loopback, HTTP server transport) through `require`.
4. **`@qduc/web-fetch` is external.** It was already imported on demand, but its
   jsdom tree (about 7 MB) sat in the bundle, read and decoded on every start
   (UTF-8 decoding of the bundle fell from 38 to 24 ms). This also fixes `web_fetch`
   in the built CLI, which is reached through `run_code`. Bundled, jsdom resolved
   its `xhr-sync-worker.js` relative to the bundle. At `7020c91`, every call
   returned `Error: Cannot find module './xhr-sync-worker.js'`. The candidate
   returns the page's title and markdown; the independent verifier found this, and
   a rerun reproduced it. No test drives `web_fetch` through the built CLI.
5. **Lazy initialization in the bundle:** the MCP client SDK (about 25 ms) loads
   with the first server connection or login (`tools/mcp/mcp-sdk.ts`), the
   OpenRouter AI SDK (15 ms) with the first OpenRouter model, and six unused
   mode-notice constants (17 ms of profile resolution at import) were deleted.
6. **`launch.ts` loads the headless runner only for a headless run.** Its static
   re-export initialized the application graph for every command, `--help`
   included.
7. **The installed `term2` enables Node's compile cache.** Users had none:
   with the base build, a cold-cache start took 859 ms against 747 ms warm
   (n=8, `NODE_ENV` unset, non-answering PTY). `dist/cli.js` calls
   `module.enableCompileCache()` before importing the bundle, in
   `TERM2_CACHE_DIR` or env-paths' per-user cache, not Node's default under
   `os.tmpdir()`: Node adopted a pre-existing world-writable directory there
   without complaint, which on a shared host would let another user plant
   bytecode. A cache directory that cannot be created (a `/sys` path, EPERM; a
   path through a regular file, ENOTDIR) returned status 0 and the CLI started
   normally on Node 22.23.4 and 24.21.0. On both versions, though, directory
   creation spun at 100% CPU and never returned for a path under `/proc`; the
   same applies to `NODE_COMPILE_CACHE` there.

### Remaining costs, not changed

- **React development build in test children.** They set `NODE_ENV=test`,
  which `config/env-setup.ts` keeps (settings and OAuth code branch on it), so
  e2e launches render with `react-reconciler.development` (about 36 ms self per
  launch); users get the production build. Changing it is an owner decision
  about which build the suites exercise.
- **Lazily compiled code is never cached.** Node writes the entry's V8 code
  cache right after compiling it: the cache was byte-identical after `--help`
  and after a full TUI start (1.7 MB for the 17.7 MB base bundle), so every
  launch recompiles each function it calls (58 ms charged to esbuild's `__init`
  at base). Caching it would need a loader that writes the cache after startup,
  such as `vm.Script#createCachedData`; not attempted.
- `string-width`: about 15 ms to initialize (`Intl.Segmenter`) and 20 ms in
  Ink's `widestLine` on the non-ASCII glyphs of the first frame.
- zod: about 75 ms self, mostly constructing and applying the settings and
  Profile schemas; converting tool parameters to JSON Schema
  (`sourceToolSpec`) took about 5 ms.
- Two synchronous `git` spawns while the tool surface is built (5–7 ms here,
  outside a repository; more inside one).

### Verification

Author checks ran on the candidate's working tree on top of `7020c91`, before it was
committed; later edits touched only this section and other prose. The container
ran as root, with Node 24.21.0 and, as `setup-tests` installs them, `bubblewrap`
and `socat`.

| Check | Result |
| --- | --- |
| `node scripts/run-ci-lane.mjs test` | 110 of 110 passed |
| `node scripts/run-ci-lane.mjs integration`, pnpm 11.7.0 | 179 passed, 1 skipped, 2 failed; the two failures are root-only, see below |
| `node scripts/run-ci-lane.mjs e2e` | 199 of 199 passed in each of two runs, all ten `restart.e2e`/`restart-native.e2e` cases included |
| `node scripts/run-ci-lane.mjs provider-black-box` | 202 passed, 1 skipped |
| The `port` job: `parity/run.mjs check --cli dist/cli.js`, `bench/hops.mts`, `bench/m1-direct.mjs` | 9 of 9 goldens match; message path within budget; 33 of 33 rows passed |
| `tsc -p tsconfig.build.json --noEmit`, `tsc --noEmit`, `check-layers`, `check-reachability`, `check-complexity`, `check-rules`, `check-baselines` (against `7020c91`), `check-root`, `check:no-unit-tests`; eslint and Prettier on the changed files | all passed |

Failures that came from the container rather than the change, each matched on
the base build:

- **Running as root.** `tests/session/logging/logging-failures.integration.test.ts`
  makes directories unwritable with `chmod 0o555`, which root ignores. Two cases
  failed on both builds as root; the file passed 5 of 5 as an unprivileged user.
- **No `bubblewrap`/`socat`.** Before they were installed, 12 Bare-profile cases
  in `tests/cli/cli-headless.integration.test.ts` returned "Sandbox blocked this
  command" or "Tool execution was not approved". The same 12 failed on the base.
- **pnpm 10.28 instead of 11.** `package.json` requires pnpm 11 or later. With
  10.28 on the path, `pnpm publish --dry-run` handed off to the npm 11 that comes
  with Node 24, which contacted the fixture registry, and three accepted cases in
  `scripts/release-identity.integration.test.ts` failed on both builds. With pnpm
  11.7.0 the file passed 18 of 18.
- **Node 22.23.4.** `discord-images.integration.test.ts` › "ends a stalled
  response body within the shared 30-second download deadline" timed out at
  35 s on both builds; it passed on Node 24.

On Node 22, one provider-lane run failed on the candidate only, and it was not
reproduced. `input-notice.blackbox.ts` › "retries the original pasted image and
chains the following turn" timed out after 40,000 ms waiting for `/retry-turn`
"after revision 3; got revision 4". The composer still held the submitted text
and image marker, so the typed command was appended to it. The base passed that
run. The file then passed 10 of 10 alone and 8 of 8 beside four busy loops on
each build, and the whole provider lane passed on Node 24. The change does not
touch the composer, paste or submit path. The cause is unknown; the signature is
recorded in the `testing` skill.

Behavioral probes on the built CLI, base against candidate, on Node 22:

- **MCP.** A stdio echo server reached ready with its one tool (`echo__ping`). A
  refused HTTP server failed, and a 401 server was classified as needing auth.
- **Terminal background.** The background replies were described in item 1 above.
- **SSH.** A refused connection reported ECONNREFUSED alike from the bundle and
  from `dist/cli.js`.
- **Sandbox.** Three scenarios gave identical results.
- **Commands that do not launch.** `--help`, `--version`, `--resume ls`,
  `control --help`, `discord --help`, a bad flag, a bad model and a bad provider
  gave byte-identical output.
- **Login.** `--codex-login` bound its loopback port and answered HTTP 200.
- **Compile cache from `dist/cli.js`.**
  - By default it was created under the user's cache directory with mode 755.
  - `TERM2_CACHE_DIR` was honoured.
  - `NODE_COMPILE_CACHE` took precedence.
  - `NODE_DISABLE_COMPILE_CACHE` wrote nothing.

**Independent verification: accepted.** A separate agent verified commit
`021d9e6` against `7020c91` on Node 24.21.0 with pnpm 11. It ran its own probes
and found no blocking defect:

- **Sandbox enforcement.** Writing outside the workspace and reading
  `~/.ssh/id_rsa` were denied identically on both builds.
- **A sandbox runtime that throws on import.**
  - The base crashed even on `--help`.
  - The candidate started and failed closed: commands that needed the sandbox
    were refused or asked for approval, and ACP reported `missing_dependency`.
- **MCP.** Classification output was byte-identical for 401s over streamable HTTP
  and SSE, refresh-only tokens, crashed servers and servers that died mid-call. A
  full PTY `/mcp-login` OAuth flow matched too.
- **SSH.** A round trip against an in-process ssh2 server matched.
- **Headless SIGINT/SIGTERM exit codes.** They matched.
- **Background replies.** A sweep of late replies matched the timings in item 1.
- **Bundle markers.** All 866 `// dist/` markers survived.
- **Compile cache.**
  - The default directory, `TERM2_CACHE_DIR`, `XDG_CACHE_HOME`,
    `NODE_COMPILE_CACHE` precedence and `NODE_DISABLE_COMPILE_CACHE` behaved as
    described.
  - ENOTDIR, EROFS and unwritable-HOME starts succeeded.
  - `NODE_COMPILE_CACHE` did not leak to child processes.
- **CI checks.**
  - It repeated all four lanes and reached the same results.
  - The `port` checks passed.
  - `input-notice` passed 12 of 12 under load.
- **What it found, and could not verify.**
  - It found the `web_fetch` fix in item 4 and the two side effects in item 1.
  - It could not verify a Node older than 22.1 (that was simulated), macOS or
    Windows cache paths, or the `input-notice` failure on Node 22.

Limits:

- No hosted CI run is included.
- Timings are local samples from one container.
- Most probes ran on Node 22 only.
