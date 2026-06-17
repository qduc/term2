 # Migrate AVA To Vitest

This repository is still AVA-based. Tests live under `source/**/*.test.ts` and `source/**/*.test.tsx`, and `package.json` currently drives them with AVA (`test` and `test:verbose`). `tsconfig.json` is already `NodeNext` / `ES2022`, so Vitest can run the TypeScript sources directly once the runner is introduced.

Current migration surface, at the time of writing:

- 254 test files under `source/`
- 36 TSX test files
- many `test.serial` call sites
- 53 `t.teardown` call sites
- 8 `test.after.always` or `test.serial.after.always` call sites
- no AVA snapshot files, no `t.snapshot`, no `test.macro`, and no `t.context` usage in tests

## Goal

Move the suite from AVA to Vitest without changing test intent. The migration should keep behavior visible, especially around cleanup, serial execution, and error assertions, rather than hiding semantic changes behind a broad automated rewrite.

## Repo-Specific Migration Shape

Use six stages:

```text
Inventory -> Vitest bootstrap -> Mechanical codemod -> Manual cleanup -> Dual-run validation -> Cutover
```

### 1. Inventory the AVA surface area

Before touching test files, add a small inventory script or one-off report for `source/**/*.{test.ts,test.tsx}`. The report should classify:

- AVA imports
- `test.serial`
- `test.after.always` and `test.serial.after.always`
- `t.teardown`
- `t.throws` and `t.throwsAsync`
- custom matchers or unusual assertions

This repo does not appear to use AVA snapshots, macros, or `t.context` in tests, so those buckets should stay empty. If any of them appear in a later scan, pause and review the file manually before converting it.

Representative files that are likely to need manual attention:

- `source/services/subagents/subagent-manager.test.ts`
- `source/hooks/use-model-selection.test.tsx`
- `source/components/InputBox.test.tsx`
- `source/services/session/*.test.ts`
- `source/providers/*.test.ts`

### 2. Add Vitest alongside AVA

Do not remove AVA in the first pass.

Edit `package.json` to add Vitest scripts beside the existing AVA scripts:

```json
{
  "scripts": {
    "test:ava": "ava --reporter=min",
    "test:vitest": "vitest run",
    "test:vitest:watch": "vitest",
    "test:vitest:coverage": "vitest run --coverage"
  }
}
```

Add a standalone `vitest.config.ts` at the repo root. Start with explicit imports instead of globals so the suite stays close to the current AVA style:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

Keep the existing AVA scripts in place until the migrated suite is stable. The first Vitest pass should not change production build flow or require a Vite app runtime.

### 3. Build a codemod for the mechanical cases

Create a small codemod set under `scripts/codemods/ava-to-vitest/` or a similar repo-local migration directory. Keep the transforms narrow and testable.

Mechanical conversions that should be automated:

- `import test from 'ava'` -> `import { test, expect } from 'vitest'`
- `test.serial(...)` -> `test.sequential(...)`
- `test.before(...)` -> `beforeAll(...)`
- `test.after(...)` -> `afterAll(...)`
- `test.beforeEach(...)` -> `beforeEach(...)`
- `test.afterEach(...)` -> `afterEach(...)`
- `t.is(a, b)` -> `expect(a).toBe(b)`
- `t.deepEqual(a, b)` -> `expect(a).toEqual(b)`
- `t.notDeepEqual(a, b)` -> `expect(a).not.toEqual(b)`
- `t.true(value)` / `t.false(value)` -> boolean assertions with `expect`
- `t.truthy(value)` / `t.falsy(value)` -> `toBeTruthy()` / `toBeFalsy()`
- `t.regex(value, re)` / `t.notRegex(value, re)` -> `toMatch()` / `not.toMatch()`

Cases that should stay explicit or be marked for review:

- `t.throws` and `t.throwsAsync`
- `t.teardown`
- any file that mixes cleanup with mutable shared state
- any test that would be tempted into a double invocation of the subject under test

### 4. Handle the AVA cleanup semantics deliberately

This repo uses a lot of teardown-style cleanup. That deserves a dedicated migration rule, not a generic assertion transform.

Conversion guide:

| AVA pattern | Vitest direction |
| --- | --- |
| `test.after.always(...)` | `afterAll(...)` |
| `test.serial.after.always(...)` | `afterAll(...)` |
| `t.teardown(...)` | `onTestFinished(...)`, `try/finally`, or a local cleanup helper |

Do not convert per-test cleanup to suite-level cleanup unless the code clearly only owns suite-wide resources. The 53 `t.teardown` call sites are the main place where an automated rewrite can silently change behavior.

### 5. Convert the tests in small batches

Migrate files in batches of roughly 5 to 15, starting with the least stateful suites. Favor utility-heavy and pure assertion tests before the heavier Ink, session, and provider suites.

For each batch:

1. Convert imports, hooks, and basic assertions.
2. Leave `throws`/`throwsAsync` and cleanup-heavy files for explicit review when necessary.
3. Run the affected Vitest files immediately.
4. Run the matching AVA files until the batch is fully switched.
5. Fix any ordering or isolation issues before moving on.

The repo already has many serial tests, so keep a close eye on any file that relied on AVA's concurrency model or on incidental file isolation.

### 6. Validate the transition and cut over

Once the migrated batches are green, run both runners in parallel until the counts and behavior match the current suite.

Validation should compare:

- discovered test count
- pass/fail/skip totals
- teardown behavior
- runtime
- any changed error text or thrown-error shape

When the Vitest suite covers the whole repo:

- switch `test` to Vitest
- keep or rename `test:verbose` as a Vitest equivalent if it still adds value
- remove AVA config from `package.json`
- remove the AVA dependency and any codemod scaffolding

## Data Flow

Test files stay colocated with production code in `source/`. Vitest reads the TypeScript and TSX test files directly, so the current `tsc && ava` compile-before-test flow only needs to remain for production builds, not for test execution.

Ink and React tests should continue to run in Node unless a specific file requires `jsdom`. Most of the existing component tests are Ink-based, not browser-DOM-based, so `environment: 'node'` is the right starting point.

## Edge Cases

- No AVA snapshots exist today, so snapshot migration is not part of the first pass.
- No `t.context` usage was found in tests, so Vitest fixtures are optional rather than required.
- `t.throws` and `t.throwsAsync` need manual review where the subject has side effects or where the AVA test captured the thrown error for extra assertions.
- `test.serial` should not be bulk-converted into concurrency; preserve the current execution intent first, then optimize later if a file is proven safe.
- Files using `t.teardown` around temp directories, provider registries, or Ink cleanup need special care.

## Acceptance Criteria

The migration plan is complete when:

- the repo has a working `vitest.config.ts`
- Vitest can run the colocated `source/**/*.test.ts(x)` suite
- all AVA-only syntax in migrated files has been removed or intentionally left with a review marker
- cleanup semantics are preserved for suite-level and per-test teardown
- the final cutover removes AVA without regressing coverage or test counts

## Assumptions

- The repo will keep AVA and Vitest side by side during the transition.
- The first Vitest pass will use `environment: 'node'` and explicit imports.
- No additional browser runtime is needed unless a specific test file proves otherwise.
- There is no need to plan for snapshot migration because this repo does not currently use AVA snapshots.

## Risks

- The main risk is semantic drift in cleanup and error assertions, not import syntax.
- The second risk is hidden ordering or shared-state assumptions in the many `test.serial` files.
- The third risk is over-automating `throwsAsync` and accidentally invoking a side-effectful function twice.

## Notes For The Implementer

- Keep the codemod deterministic and conservative.
- Prefer leaving a file unchanged with a review marker over guessing.
- Add Vitest support first, then migrate tests, then remove AVA.

