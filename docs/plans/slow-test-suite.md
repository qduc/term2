Status: plan. Attribution experiments complete 2026-08-29 — see "Attribution experiment results".

## Resume here

The deterministic no-isolate lane is landed (`pnpm test:lane`, 490-file
manifest, 180 s hang guard) but its final manifest still needs one clean
verification round: run `pnpm test:lane` and, if a fresh seed fails, union
the failing files into the manifest's exclusion list as in rounds 1–3. After
that, the remaining options in "Future work" apply, in order. Context for
the current state (leak classes, the seed-888 hang, what was measured) is in
the "Deterministic lane" section below and in project memory
`slow-test-suite-profile-2026-08-29`.

# Slow test suite

## Problem

The default Vitest run takes about 77 seconds locally, which is too slow for
fast development feedback. It currently runs the complete source and scripts
test inventory together rather than providing a fast unit-test-only gate.

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
  on fresh seeds until a full round comes back clean. 36 files are excluded
  with per-file reasons in the manifest header (provider registry, Grok credit
  singleton, session-runtime/workspace-root state, shell-sandbox state, and
  others).
- The runner carries a 180 s per-seed guard (~7× a healthy ~25 s run) because
  a non-isolated run can hang when a leaked keepalive holds the worker pool
  open (observed reproducibly on seed 888: no output for 15 min, 3 cores
  spinning). The 22 keepalive-pattern suspects among the never-started files
  pass cleanly on their own, so the hang needs a poisoner–victim pair spanning
  the run order; bisecting it is left as follow-up. The shipped default seeds
  (`20260829`, `314159`) are hang-free and failure-free.
- Status: rounds 1–2 committed; round 3 flagged 3 more files (trimmed,
  re-verification round pending). Growth path: additional files enter the
  manifest only after passing a fresh shuffled seed (`pnpm test:lane:seed
  <new-seed>`).

## Acceptance criteria

- A documented unit command runs without provider/network/process side effects
  and is materially faster than the current full command (61 s vs 84 s measured
  at the tier split alone; the curated no-isolate subset targets ~30 s).
- Integration and end-to-end tests remain runnable through explicit commands.
- The patch-healing error tests do not invoke a real provider.
- The full suite still passes with `NODE_ENV=test` after the split.
- Any no-isolate lane proves leak-free via shuffled, seeded repeat runs, and
  the isolated full suite remains the authoritative handoff gate.


