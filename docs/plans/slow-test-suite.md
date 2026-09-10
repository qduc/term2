Status: plan. Tier split merged to main (`33e5e6f2`, 2026-09-10); the <30s target is measured as host-bound on the 4-vCPU workstation — see "Tier split and 4-vCPU measurements (2026-09-10)".

## Resume here

`pnpm test` is now the unit tier only. `vitest.config.ts` excludes
`**/*.integration.*` and `scripts/provider-black-box/**`; the new
`pnpm test:integration` (`vitest.integration.config.ts`) owns the nine
`*.integration.*` files, and `vitest.provider-black-box.config.ts` keeps
owning the black-box scripts — which `scripts/**/*.test.ts` had also been
matching in the default suite, so each of those files ran twice. CI and the
publish gate run both commands. The split is coverage-neutral: 608 files /
8342 tests (`pnpm test`) + 9 files / 80 tests (`test:integration`) + 14
files / 95 tests (black-box) = the 631 files / 8517 tests the default suite
ran before it.

The split bought 11 s, not the target: `pnpm test` went 150.0 s → 138.6 s.
**The <30s target is not reachable on the 4-vCPU workstation by any
configuration measured so far.** The isolated unit tier is 138.6 s; the same
tier unisolated is 58.0 s but fails 91 tests across 32 files, and excluding
those 32 files drops it to 48.0 s — while still failing 12 tests in five
*different* files, so no leak-free unisolated number has been measured. The only <30s run measured on this host is the
curated `pnpm test:lane` at 28.6 s, and it covers 476 of the 608 unit files.

Next steps, in the order the evidence supports:

1. **Repair the no-isolate leak set.** It is the only lever that touches the
   dominant cost — the unit tier is 138.6 s isolated against 58.0 s unisolated
   on identical files. The unit-tier victims observed on 2026-09-10 are listed
   below, but membership is order- and load-dependent (the same run produces
   different victims on repeat), so re-verify with shuffled seeds under
   contention and keep the isolated suite as the authority.
2. **Shard the stragglers** once (1) lands. Packing, not work, is the second
   cost: `cli.integration.test.ts` is ~31 s of serial child-process spawns in
   one file, and the 449-file tail experiment below already showed a small
   number of long files extending the wall.
3. Re-run the worker-scaling comparison in a quiet window (old item 5), then
   `jsx: react-jsx` (old item 6); neither is covered by the 2026-09-10 runs.

Context for the older state (leak classes, the seed-888 hang, the manifest
drift) is in "Deterministic lane" below and in project memory
`slow-test-suite-profile-2026-08-29`. The 2026-09-10 numbers are in project
memory `full-suite-runtime-4vcpu-measurements`.

## Tier split and 4-vCPU measurements (2026-09-10)

All runs on the 4-vCPU workstation (`nproc` = 4), `NODE_ENV=test`, warm
caches, wall time from `/usr/bin/time`. **The host was not quiet** — other
work kept load around 1.6–1.9 — and the 84 s / 77 s figures elsewhere in this
document come from an 8-vCPU host, so they are not comparable to these.

| configuration | files | wall | failures |
| --- | ---: | ---: | --- |
| `pnpm test` before the split (forks, isolated) | 631 | 150.0 s | 5 (TMPDIR env noise) |
| `pnpm test` after the split (unit tier, isolated) | 608 | 138.6 s | 5 (TMPDIR env noise) |
| `pnpm test:integration` (new) | 9 | 29.3 s | 0 (1 skipped) |
| unit tier, `--isolate=false` | 608 | 58.0 s | 91 across 32 files |
| unit tier, `--isolate=false`, the 32 observed victims excluded | 576 | 48.0 s | 12 across 5 *different* files |
| `--experimental.fsModuleCache=true` (cold / warm) | 631 | 149.2 s / 141.3 s | 5 |
| `--pool=threads` | 631 | 203.5 s | 60 |
| `--pool=threads --isolate=false` | 631 | 125.6 s | 60 |
| `pnpm test:lane` (curated no-isolate manifest, seed 20260829) | 476 | 28.6 s | 2 (TMPDIR env noise) |

What these rule out:

- **Worker scaling.** `--isolate=false --maxWorkers=8` on 4 cores moved 77.0 s
  to 66.0 s (~14%), so the suite is CPU-bound rather than I/O-bound; adding
  workers is not a route to 30 s.
- **The threads pool.** Strictly worse (203.5 s) and it fails 60 tests that pass
  under the default forks pool, with or without isolation.
- **`fsModuleCache`.** ~6% warm, nothing cold.
- **Isolation as the whole problem.** Removing the observed victims does not
  converge: excluding the 32 files that failed left 12 failures in 5 different
  files, which is the same drift this document already records for the lane
  manifest. The 48.0 s run is therefore a failing run, not a leak-free floor,
  and no leak-free unisolated unit-tier number exists yet.

Vitest's own breakdown of the 28.6 s lane — `transform 9.35 s, setup 1.44 s,
import 14.96 s, tests 57.92 s` — is the other half of the picture: test bodies
dominate the work, and per-file module instantiation is what isolation adds on
top of it.

Unit-tier leak victims in the 58.0 s run (order-dependent; this is one sample,
not a stable set):

```
scripts/package-scripts.test.ts
scripts/run-test.test.ts
scripts/nested-approval/scripted-adapter.acceptance.test.ts
source/agent.test.ts
source/app.navigate-question.test.tsx
source/components/input/ApplicationInputSurface.test.tsx
source/hooks/use-grok-credit-usage.test.tsx
source/hooks/use-shell-mode.test.tsx
source/lib/agent-configuration.test.ts
source/lib/subagent-bridge.background-sink.test.ts
source/providers/codex-websocket-cancellation-settlement.test.ts
source/providers/codex.provider.test.ts
source/providers/oauth-pkce.test.ts
source/providers/openai-responses-model.test.ts
source/providers/openai.provider.test.ts
source/providers/provider-service.test.ts
source/services/approval/approval-decision-executor.test.ts
source/services/approval/approval-flow-coordinator.test.ts
source/services/execution-context.test.ts
source/services/file-service.test.ts
source/services/models/model-picker-host.test.tsx
source/services/providers/provider-management-session.test.ts
source/services/session/conversation-session.provider.test.ts
source/services/session/session-runtime.isolation.test.ts
source/services/subagents/execution-runner.test.ts
source/services/workspace/active-workspace-root.test.ts
source/services/workspace/workspace-lease-authority.test.ts
source/tools/file/apply-patch.test.ts
source/tools/file/search-replace.test.ts
source/utils/shell/execute-shell.network-approval-timeout.test.ts
source/utils/shell/sandbox/sandbox-policy.test.ts
source/utils/shell/sandbox/shell-sandbox-runner.test.ts
```

Three of those (`apply-patch`, `search-replace`, `scripted-adapter`) also
fail **isolated** on this machine for a TMPDIR reason unrelated to isolation —
see `tmpdir-local-test-failures` in project memory. Fixing them is not leak
work; removing them from the victim list is.

# Slow test suite

## Problem

The default Vitest run takes about 77 seconds locally, which is too slow for
fast development feedback. It currently runs the complete source and scripts
test inventory together rather than providing a fast unit-test-only gate.
(The 77 s figure is from the 8-vCPU host of 2026-08-29; the same run measured
150.0 s on the current 4-vCPU workstation — see "Tier split and 4-vCPU
measurements (2026-09-10)".)

## Evidence captured 2026-08-29

The correctly configured full run uses `NODE_ENV=test` and completed with 7,009
passing tests, 2 pending tests, and 843 suites. Its observed wall time was
about 77 seconds.

Running the two included roots separately showed where the time goes:

| Scope | Wall time |
| --- | ---: |
| `vitest run source` | 71.0 s |
| `vitest run scripts` | 3.1 s |

The root configuration includes every matching test under both roots:

```ts
include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts']
```

The source suite contains 549 test files. A broad inventory found approximately
71 files using Ink/React rendering helpers, 84 files with explicit waits or
deadline/timer behavior, and 277 files touching process, filesystem, socket,
WebSocket, TLS, or other operating-system seams. These counts are indicators,
not a final classification of every test.

## Known slow cases

The slowest observed tests were:

- `source/cli.e2e.test.ts` — `starts the terminal UI and exits on Ctrl+C` —
  about 5.0 s;
- `scripts/provider-black-box/provider-record-security.test.ts` — provider
  credential-isolation scenario — about 3.4 s;
- several `source/cli.integration.test.ts` cases — about 1.5–2.3 s each;
- `source/tools/file/apply-patch.test.ts` — `execute: detailed error for
  context block mismatch` — about 1.5–1.6 s;
- `source/gateway/model-list.test.ts` — about 1.4 s;
- `source/gateway/server.test.ts` — TLS network transport case — about 1.2 s.

The `apply-patch` case is also a unit-test isolation problem. Its default
`createApplyPatchToolDefinition()` dependency uses `healPatchOperation`; a
context mismatch therefore enters the patch-healing provider path instead of
using a mocked healer. The test is measuring provider setup/timeout behavior
in addition to patch error formatting.

## Attribution experiment results (2026-08-29)

All runs `NODE_ENV=test`, JSON reporter, on the 8-vCPU PVE host. The first four
ran in a quiet window (load ≤ 0.7); the worker-scaling runs were polluted by
external host load (8.8–11.9, CPU 92% busy) and are not comparable to the
quiet baseline.

| Run | Scope | Wall | Result |
| --- | --- | ---: | --- |
| baseline | full suite, 8 workers | 84 s | 7,012 passed |
| single-inputbox | `InputBox.test.tsx` alone | 5 s | 39 passed — its 8.0 s in-suite duration is mostly parallel contention, not own cost |
| tail-only | 449 smallest files (22.6 s summed test time) | 38 s | 5,335 passed — the tail takes ~38 s of wall for ~5 s of ideal work |
| head-free | full minus `*.integration.*`/`*.e2e.*` | 61 s | 6,957 passed — removing 10 files (23.8 s summed) saves 23 s of wall, near 1:1 |
| head-free, `--isolate=false` | same lane, no worker isolation | 33 s | **67 failed** — cross-file module-cache leakage |
| full, 6 workers | full suite | 89 s | contended, not comparable |
| full, 4 workers | full suite | 102 s | contended, not comparable |

Conclusions:

1. **Per-file fixed overhead dominates** (the "world 3" hypothesis). The
   449-file tail, whose test work sums to 22.6 s, needs 38 s of wall. Module
   transform + import graph + per-file worker isolation is a primary cost, not
   the head alone.
2. **The integration/e2e head also serializes the critical path**: the
   head-free run's 23 s saving is close to those files' summed time, meaning
   they run mostly unoverlapped as stragglers.
3. **`isolate: false` halves the unit lane (61 s → 33 s) but is not adoptable
   as-is.** With shared module caches, 67 tests fail from cross-file leakage:
   `vi.mock` poisoning ("Mock OpenAI" leaking into `providers/registry.test.ts`
   and `provider-service.test.ts`), the process-wide Grok credit singleton
   poisoned for later files, `ConcurrentWorkspaceRootError` from leaked session
   runtimes, and mock contamination across hooks and lib. Any adoption must be
   scoped to a verified singleton-free, mock-safe subset.
4. The single-file check confirms in-suite durations include contention; the
   JSON profile's summed worker-time is an upper bound, and wall-time
   attribution needs the run-level experiments above, not per-file sums alone.

## Likely causes (revised after experiments)

1. **Confirmed — per-file module/worker overhead across 549 files.** Largest
   single lever; only capturable for a curated safe subset (see 3 above).
2. **Confirmed — the integration/e2e head extends the critical path** with
   real PTY/subprocess/provider work (and `apply-patch`'s provider-healing
   leak). Head repairs pay back nearly 1:1 in wall time.
3. **Confirmed — Ink/React render tests are 43% of summed worker-time**, and
   their in-suite cost includes contention; repeated mounts are a real but
   partially parallelism-inflated cost.
4. **Unresolved — worker-count tuning.** The 8/6/4 scaling comparison was
   invalidated by host load; re-run in a quiet window before tuning
   `--maxWorkers`.
5. The classic JSX transform warning remains unmeasured and cheap to test
   last.

## Future work (ordered by measured leverage)

1. ~~**Isolate the `apply-patch` failure-format tests from patch-healing provider
   execution**~~ — DONE 2026-08-29: `createTool()` in `apply-patch.test.ts` now
   injects a deterministic `{ wasModified: false }` healer; the file's in-suite
   test time dropped from ~3.8 s to ~54 ms; 21/21 pass, typecheck green. The
   black-box suite run red before and after (pre-existing failure in
   `provider-session-responses.blackbox.ts` two-turn chaining) — unrelated, not
   introduced here.
2. **Define the unit lane** (`exclude: *.integration.*, *.e2e.*,
   scripts/provider-black-box`) as lane infrastructure — the scope for
   isolation experiments and future CI staging. Expect ~61 s today, less after
   head repairs. Do not market it as a developer fast gate: nobody re-runs a
   60 s pre-push hook. Developer feedback stays `test:related`/`test:changed`.
3. **Build the curated no-isolate subset on the test-audit graph.** The 33 s
   no-isolate measurement is the prize, but only a generated manifest of
   mock-safe, singleton-free tests can capture it. Selection must come from
   `docs/test-audit/graph.yaml` Domain/Suite fields (generated, validated that
   selected tests still exist), never hand-maintained, and must respect the
   audit plan's guardrails. Keep the isolated full suite as the handoff/CI
   authority; verify the subset with shuffled, seeded repeat runs before
   adoption.
4. **Repair the timing head** (`cli.integration` spawn-per-case, repeated Ink
   mounts in `InputBox`/`CommandMessage`/`BottomArea`). Check the test-suite-audit
   non-destructive milestone before rewriting test internals; consolidation or
   rework of those files may need the approval that plan describes.
5. **Re-run the worker-scaling comparison in a quiet window** before any
   `--maxWorkers` or pool tuning.
6. **Try `jsx: react-jsx` last** as warning cleanup, with before/after timing
   and the build-output tests as parity evidence.

## Deterministic lane (2026-08-29)

Landed: `vitest.lane.config.ts` (tier excludes + fixed seed),
`.github/vitest.lane.safe.txt` (leak-verified file manifest),
`scripts/run-deterministic-lane.mjs` (`pnpm test:lane` / `test:lane:seed`).
The lane runs its manifest **without worker isolation** — the dominant cost
class from the attribution experiments.

- Baseline lane (10 leak files excluded, 526 files): 17.5 s wall for 5,338
  tests, 0 local failures — down from ~61 s isolated.
- Leak discovery is order- and timing-dependent: identical seeds produced
  different failure sets across runs. The manifest is therefore trimmed to the
  **union of every observed failure** across all seeds run, then re-verified
  on fresh seeds until a full round comes back clean. The final manifest
  excludes 49 files with per-file reasons in the manifest header (provider
  registry, Grok credit
  singleton, session-runtime/workspace-root state, shell-sandbox state, and
  others).
- The runner carries a 180 s per-seed guard (~13× a healthy ~14 s run; ~7×
  when the baseline was ~25 s) because
  a non-isolated run can hang when a leaked keepalive holds the worker pool
  open (observed reproducibly on seed 888: no output for 15 min, 3 cores
  spinning). The 22 keepalive-pattern suspects among the never-started files
  pass cleanly on their own, so the hang needs a poisoner–victim pair spanning
  the run order; bisecting it is left as follow-up. The shipped default seeds
  (`20260829`, `314159`) are hang-free and failure-free.
- Status: rounds 1–3 committed; round 4 (2026-08-29) verified rounds 1–3
  clean and unioned three more order/timing-dependent leaks observed once
  each, all passing on re-run with the same seed:
  `source/services/workspace/active-workspace-root.test.ts`
  (ConcurrentWorkspaceRootError, same class as `execution-context.test.ts`),
  `source/tools/web/web-search.test.ts` (settings/env leak made the
  unconfigured-provider guard pass), and
  `source/components/input/SettingsMenuSession.test.tsx` (React update
  depth exceeded). Final manifest: 476 test files per seed, 49 manifest
  entries excluded; verified clean
  on five consecutive rounds (20260829, 314159, 24680, 135791, 987654),
  ~14 s per seed, no hangs. Growth path: additional files enter the
  manifest only after passing a fresh shuffled seed (`pnpm test:lane:seed
  <new-seed>`).

## Manifest has drifted: the lane is not a reliable gate (found 2026-09-04)

The manifest is now 567 files, up from the 476 verified on 2026-08-29, and it
no longer passes reliably. **The two default seeds fail too**, so this is not
a matter of unlucky seed choice — an earlier version of this section claimed
the defaults were green and that seed choice decided the outcome. Both claims
were wrong; repeated runs of the same seeds give different victims, so the
failures are load- and timing-sensitive, not seed-determined.

Files observed failing, across `cb73db64` (pre-merge) and current main:

| file | failing assertion |
| --- | --- |
| `provider-management-session.test.ts` | 3 `vi.mock` forwarding assertions |
| `conversation-session.isolation.test.ts` | abandoned approval follow-up |
| `conversation-session.characterization.test.ts` | auto-approve continuation |
| `conversation-session.provider.test.ts` | Codex websocket chaining |
| `BottomArea.test.tsx` | first-run provider menu handoff |
| `search-replace.test.ts` | relaxed-mode substring match |

Most reproduce on `cb73db64`, so the bulk of this is drift rather than any one
merge. **One was ours and is fixed:** `read-file.test.ts`'s scripted-cap test
read the real `source/tools/system/shell.ts` through a *relative* path and
asserted it stayed over 50,000 bytes. A relative path resolves through
`process.cwd()`, and several lane files (`glob.test.ts`, `read-file.test.ts`
itself) monkey-patch `process.cwd` globally in their `withTempDir` helper —
under `--isolate=false` those share a worker. It now uses a temp fixture.

That helper is the thing to fix next: **a global mutated inside a
non-isolated file is a hazard for every other file in its worker**, and it is
currently duplicated across at least two lane files.

For `provider-management-session`, the three tests asserting on `vi.mock`ed
functions fail while the one asserting on a plain object passes — the
shared-module-registry class this doc already catalogues. It does not
reproduce pairwise: not with its own real-module importers
(`provider-service.test.ts`, `use-provider-selection.test.ts`) in either
order, nor with any single other file. It needs a particular multi-file worker
distribution.

**The admission rule — "verified against at least two shuffled seeds" — is too
weak for a 567-file non-isolated run**, and it cannot catch a load-sensitive
failure at all. Until the 91 files added since 2026-08-29 are re-verified
against a wider seed set *and* under contention, treat a green
`pnpm test:lane` as weak evidence. The isolated full suite remains the
authority.

## Acceptance criteria

- A documented unit command runs without provider/network/process side effects
  and is materially faster than the current full command (61 s vs 84 s measured
  at the tier split alone; the curated no-isolate subset targets ~30 s).
- Integration and end-to-end tests remain runnable through explicit commands.
- The patch-healing error tests do not invoke a real provider.
- The full suite still passes with `NODE_ENV=test` after the split.
- Any no-isolate lane proves leak-free via shuffled, seeded repeat runs, and
  the isolated full suite remains the authoritative handoff gate.


