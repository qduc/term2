# Development test feedback

Use the smallest check that answers the current question, then widen coverage as
the change becomes coherent. Test selection is a way to shorten the edit loop;
it does not remove tests from CI or establish that unrelated behavior is safe.

## Feedback ladder

1. **While editing:** run the test file that reproduces or covers the behavior.

   ```sh
   pnpm test path/to/behavior.test.ts
   ```

2. **After a coherent source change:** run tests Vitest identifies as related to
   the changed source. Review the selected file and test counts; shared imports
   can make a related run much broader than expected.

   ```sh
   pnpm test:related ./path/to/changed-source.ts
   ```

   Related selection follows static imports. Dynamic loading and behavioral
   coupling may not appear in that graph, so select extra tests deliberately
   when those paths are involved. See the repository's [testing skill](../../.agents/skills/testing/SKILL.md)
   for scope selection and gate details.

3. **Before handoff:** run the changed-file selection and typecheck for a narrow
   change, along with any directly affected integration or e2e checks. A
   changed or related command that selects zero tests exits with an error; that
   is not a passing check. Select an appropriate test explicitly or broaden
   coverage.

   ```sh
   pnpm test:changed
   pnpm typecheck
   ```

4. **Completion:** keep the repository-required CI and publish gates intact.
   Current CI runs unit and integration suites, plus separate e2e and provider
   black-box jobs. A local selection never replaces those gates. Track late CI
   failures until they pass or have a clearly owned, explicit blocker. At
   baseline `main` revision `f33995f1`, CI was configured for pushes to `main`
   only; draft PR #22 had no remote CI checks when opened.

When impact is uncertain, broaden the selection. Lint and typecheck help catch
static problems but do not replace behavioral checks. Do not exclude failing
tests, weaken isolation, or report a speedup from a run that fails.

## Footprint-based selection (prototype)

`pnpm test:impact` selects tests by the source lines each one executed rather
than by import graph, which fans out through hub modules. It is a prototype
with known gaps and never replaces the CI gates; see
[test-impact-map.md](../plans/test-impact-map.md) before relying on it.

## Measured selection example

On current `main` (`f33995f1`, 2026-10-07), selecting the related tests for
`source/utils/value-suggestions.ts` ran 24 files and 1,403 tests in 21.5 seconds
wall time. Selecting its explicit behavioral test file ran 1 file and 31 tests
in 1.5 seconds. Both runs passed. The explicit test is useful during edits to
that behavior; the wider related run provides stronger impact coverage before
handoff. This is one warm-cache sample on this environment, not a general
performance guarantee. Re-measure before attributing time or promising savings.
