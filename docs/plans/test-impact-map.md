# Test impact map

**Status:** prototype, measured 2026-10-07 on a 4-core machine. Not wired into
CI or the default `pnpm test`; the full unit and integration suites remain the
required gates. Treat numbers as one machine's observations, not guarantees.

## What it is

`pnpm test:impact:record` runs the unit suite once with V8 precise coverage and
records, per test file, which original source lines it executed (mapped back
through the source maps) and which non-code files it read. `pnpm test:impact`
then compares the working tree with the tree the map was recorded at and runs
only the tests whose footprint a change touches.

The unit of impact is the executed line, not the file. File-level import
selection fans out through hub modules: on the 2026-10-07 tree, editing one
line selected a median of 150 of 707 test files by static imports, against a
median of 5 by footprint (p90 105, max 287).

## How a test is selected

A test is selected when a change touches a line it executed, a file it read,
the directory it listed, or a script it spawned (or that script's imports and
directory). Added, deleted and renamed files count as touching every line.
Files with a per-case footprint (below) select individual cases, otherwise the
whole file runs.

Every uncertainty resolves toward running more:

- A changed `.ts`/`.tsx` file that does not parse selects everything, because a
  syntax error breaks every importer whatever lines it executed.
- A change to `package.json`, the lockfile, `tsconfig*`, `vitest*.ts`,
  `source/test-helpers/`, or this tool selects everything.
- A script whose source map is missing is recorded as wholly executed.
- Original lines no generated line maps to (closing braces, comments) inherit
  the status of the nearest mapped line above, never "unexecuted".
- A test file with no recorded footprint always runs.

## Per-case selection

`scripts/test-impact/order-independent.txt` lists heavy files that passed three
shuffled test orders (`--sequence.shuffle.tests`, seeds 101, 202, 303). Only
those get per-case footprints, and a change selects single cases in them. A
change to import-time or hook code selects the whole file. Do not add a file
without shuffling it first: running one case alone is only safe if no case
depends on state another leaves behind. `run-code.test.ts` alone was 21.7s of a
25s small-change run before this.

## Evidence it is sound

Breakage trials: replace a sampled executed `return` with a `throw`, take the
selector's output, run the full unit suite, and require every failing test to
be in the selected set. Seven file-level trials and five case-level trials found
no miss. One further trial hung (an infinite loop in a test) and was killed by
the harness timeout, so it is excluded rather than counted. Twelve trials do not
prove soundness; they found no hole in the paths they exercised. Two holes were
found and closed along the way: source-map comments followed by a trailing
`vitestCache=` comment silently disabled mapping, and wrapping `execFile`
dropped its `util.promisify` symbol.

## Known gaps

- A test that runs repo code in a subprocess is only as well tracked as its
  spawn arguments. Named scripts are followed (static relative imports plus the
  script's directory); an opaque spawn through `tsx`, `npx` or `pnpm` runs on any
  code change. Dynamic imports inside the child are not followed.
- Reflection on source text (`Function.prototype.toString`, reading `.ts`
  files at runtime) is only caught if the read goes through `fs`.
- The footprint is only as good as the tests: a line no test executes selects
  nothing. 5.1% of source lines were executed by no unit test.
- Selection reasons about the diff against the recorded tree. A stale map is
  safe but selects more; re-record after large merges.
- Never a substitute for the CI unit and integration gates.

## Measured on this machine

Small edit (one line in `format-helpers.ts`), end to end including selection:
about 24.5s with file-level footprints, 11.8s with per-case footprints, against
73.5s for `vitest related`. Medium edit (`run-item-normalizer.ts`): about 31s
against 111s. Neither meets the 5s and 15s targets.

What is left is module loading, not test code. For the medium selection, test
bodies were 14.9s while import was 61s and transform 15s, summed across workers;
the provider and AI-SDK graph is about 28% of import self-time. Persisting the
transform cache (`experimental.fsModuleCache`) removed most of the transform
share. Reaching the targets needs less import evaluation per test file.

## Commands

    pnpm test:impact:record   # one-time, ~4 min; writes node_modules/.cache/test-impact
    pnpm test:impact          # select and run

Files: `scripts/test-impact/` (`recorder.setup.ts`, `record.mjs`, `select.mjs`,
`run.mjs`, `tree.mjs`) and `vitest.impact.config.ts`.
