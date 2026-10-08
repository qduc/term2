Status: opt-in, measured 2026-10-08 on one 4-core VM. `pnpm test` is unchanged and stays fully isolated; `pnpm test:hybrid` and `pnpm test:shared` are development accelerators. Whether either may gate a pull request is an open policy decision (see "Decision needed").

# Shared-worker test runs

## Why

The unit suite is CPU-bound, and most of the CPU is paying the same initialization bill once per
file: a profile of the busy time inside test processes put about 10% in test and application code
and about 30% in parsing and compiling modules, 14% in Vitest's module runner, 12% in Node's module
loader, 9% in zod schema construction and 8% in GC. 550 of 708 files finish in under 300 ms yet make
up about half of all import time. Running each file in a fresh process is what makes the cost
repeat, and it is also what keeps files from affecting one another. This document is about getting
the first without losing the second.

## Modes

| Command | Isolation | Earlier window | Final window |
|---|---|---|---|
| `pnpm test` | every file in its own process | 118.8 s | 138.4 s |
| `pnpm test:hybrid` | 474 verified files share workers; the rest isolated | 75.8 s | 91.6 s |
| `pnpm test:shared` | every file shares workers, with a per-file reset | ~66 s | 67.7 s |

Each column is one window on one 4-core VM whose speed drifts between sessions by ~15%, so compare
within a column, not across. Within the final window the shared run took 51% less time than
`pnpm test` and the hybrid 34% less. The original configuration, before this work, took 162.9 s in
the earlier window. All three modes ran the same 10,990 tests and failed the same single test
(`run-code.physical-binding`, which fails the same way on the original configuration).

## What the shared run resets

Plain `isolate: false` fails 19-25 files per shuffled run: application singletons leak. What fixes
it is resetting, after every file, the state an isolated run would have discarded
(`source/test-helpers/vitest-reset-modules.ts`, built on `vitest-process-state.ts`):

- the application module registry, via `vi.resetModules()`. Native ESM in `node_modules` is not part
  of that registry, so heavy libraries (`ink`, `zod`, the provider SDKs) stay loaded once per worker;
- `process.env`, including the object itself, and the working directory;
- application-owned globals (`term2*`). Globals that libraries install at import (React's act flag,
  zod's registry, undici's dispatcher) are not removed, because a library loaded once per worker
  does not run its setup again;
- the test cache directory is fresh per file (`vitest-cache-isolation.ts`).

Not reset: handles that outlive a file (sockets, timers, child processes) and the heap, which grows
to roughly 500-700 MB per worker.

## How it was checked

Failures were chased to a cause each time instead of excluded:

| Symptom in shared runs | Cause | Fix |
|---|---|---|
| `recent-conversations` returned `[]` | two tests restored the environment with `process.env = copy`, replacing Node's environment object with a plain object so a later worker thread never saw its variables | harness restores the real object; the two tests restore in place |
| `application-stream-boundary` ENOENT, `agent.test` off by one entry | `settings-service.test` created `source/test-settings` while others walked or listed `source/` | moved to the OS temp dir |
| an index database from one file visible to the next | `TERM2_CACHE_DIR` was set once per process | set once per file |
| `agent.test` off by one entry, earlier | tests created non-dot files in the repository root | moved to private temp dirs |
| `candidate-gates` deadline test | a 100 ms deadline had to outlast a child's startup and any event-loop pause | 1000 ms deadline, same assertions |

Evidence for the current code, all with file order shuffled and 4-8 workers:

- A 28-round hunt: 27 clean. The one failure was a 10-second timeout of a test that normally takes
  0.2 s, at 8 workers (twice the cores). At 4 workers 9 of 9 rounds were clean, at 6 workers 10 of 10.
- A confirmation run at 6 and 4 workers: 12 rounds, all clean; it was stopped at 12 of a planned 14.
- For comparison, the same kind of campaign before the fixes failed in 7 of 30 rounds, and after
  some of them in 3 of 30.

Shuffling alone cannot prove absence of a leak; it found one only after clean streaks more than once.
One more intermittent failure showed up in three natural-order runs (`candidate-gates`, a 100 ms
deadline); the deadline was widened afterwards and that file has not failed since.

## Finding a leak without waiting

- `node scripts/test-impact/leak-scan.mjs` reads every test file (about 3 s, nothing runs) and flags
  constructs that leave state behind or write into the repository. All five known culprits are
  flagged in their pre-fix versions. It does not predict victims, the files that merely read
  polluted state, so it complements shuffled runs. A guard test fails when a new unreviewed pattern is
  added; mark a reviewed exception with `// leak-scan-allow <rule>: <why>`.
- A failure that depends on which files shared a worker is reproducible: capture each worker's file
  order with `TERM2_SHARED_TRACE=<path>`, then `node scripts/test-impact/ddmin-order.mjs <order-file>`
  (failing file last) replays that order in one worker and shrinks it to the file that causes the
  failure. `TERM2_SHARED_LEAK_LOG=<path>` lists what each file left behind.

## Known limits

- Shuffled runs sample orderings; they do not cover all of them.
- A test that leaves a handle open can affect later files; only the scan's `handle` and `listener`
  rules look for it.
- A long-lived worker has a large heap, so a test with a tight real-time deadline can see a GC
  pause that an isolated process would not. 10-second timeouts have been seen rarely at 8 workers.
- A file with a new kind of leak is found by the next shuffled campaign, not by this document.

## Decision needed

`AGENTS.md` names the isolated suite as the CI and handoff authority. The shared and hybrid runs
only change what happens on the machine they run on; they would need that policy changed before
they could gate a pull request. A reasonable shape is the shared run as the PR gate with the isolated
run before release or nightly, but that trades some confidence for about 45% less time and is not
decided here.
