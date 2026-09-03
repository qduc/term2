# Fix: regressions found in REVIEW-model-partial-match.md

Fixes findings 1-4 from [REVIEW-model-partial-match.md](REVIEW-model-partial-match.md) (commit `c51fb860`).

## What changed per issue

### 1. HIGH — `--model` permanently rewrote `settings.json`
**`source/cli.tsx`**: the three `settings.set()` calls after resolution now pass `{ persist: false }` (same precedent as `source/gateway/runtime-factory.ts:177`), so `--model` is a per-session override again — exactly what main did via `cliOverrides`. Also prints `resolution.warnings` (issue 4) to stderr before applying the override.

### 2. HIGH — vendor-prefixed ids hijacked when the vendor name is a provider id
**`source/services/models/model-resolution.ts`**:
- `matchModels` gains a **stage 0**: an exact match of the flag *as typed* (prefix included) wins over the split provider+pattern reading. `anthropic/claude-3.5-sonnet` as a literal id on an aggregator now resolves verbatim instead of being reinterpreted.
- `resolveModelFlag` narrows the catalog load to `[provider]` **only when the user passed `--provider`**; a prefix parsed out of the flag itself no longer narrows, so the other providers' catalogs are visible to stage 0 (this is what made the old cross-provider exact test unreachable in production).
- Passthrough paths (harness, all-catalogs-failed, target-catalog-failed) return `parsed.rawPattern` instead of the stripped pattern, so fail-open behavior sends the flag as typed — matching pre-resolution behavior on main.

### 3. MEDIUM — `--json` stdout pollution
**`promptForDisambiguation`** defaults its output to `process.stderr` instead of `process.stdout`. Prompts are interaction, stdout is the NDJSON/data channel; stream injection for tests is unchanged.

### 4. MEDIUM — silent substitution during partial catalog outage
**`resolveModelFlag`** builds `warning: <provider>: <error>` lines (same format as `--list-models`) from failed groups and attaches them to `resolved`/`passthrough` results; `cli.tsx` prints them to stderr. Resolution still proceeds, but no longer silently.

## Regression tests (each verified to fail on pre-fix code)

Unit (`source/services/models/model-resolution.test.ts`, 27 → 31 tests):
- `prefers the id exactly as typed over the split provider+pattern reading` — failed pre-fix (returned 2 matches).
- `resolves a vendor-slash id on the serving provider even when the vendor name is also a provider id` — calls `resolveModelFlag` with **no** `providerIds`/`knownProviders`, mirroring the cli.tsx call site; failed pre-fix (`no_match`). Replaces the reachability gap of the old hand-fed-groups-only coverage (the old `matchModels` slash-id test is kept — it is correct for the helper).
- `resolves a provider-prefixed pattern within that provider when the stripped pattern is an exact id` — guards the fix against overcorrecting (passes before and after).
- `surfaces fetch warnings when resolution proceeds despite a failed provider catalog` — failed pre-fix (no `warnings`).
- passthrough test updated for `rawPattern` + `warnings` — failed pre-fix.

E2E (`source/cli.integration.test.ts`, 8 → 11 tests), using an in-process mock OpenAI-compatible server that records the `model` field of every chat request:
- `CLI --model keeps settings.json session-only when resolution passes through an unreachable catalog` — failed pre-fix (settings.json got rewritten).
- `CLI --json routes the ambiguous --model disambiguation prompt to stderr, keeping stdout machine-readable` — failed pre-fix (prompt on stdout).
- `CLI --model vendor/id resolves the literal id on the serving provider, warns about failed catalogs, and persists nothing` — failed pre-fix (narrowed to the real `openai` provider, never reached the mock); asserts the literal `openai/gpt-test` id reached the mock's wire, `warning: brokenprov:` on stderr, exit 0, NDJSON-clean stdout, and untouched persisted settings.

Note: the new E2E tests spawn the CLI with async `spawn` because the mock server lives in the test process — a synchronous spawn deadlocks the event loop the server needs.

## Verification

| Command | Result |
| --- | --- |
| `pnpm typecheck` | pass (`tsc --noEmit`, exit 0) |
| `NODE_ENV=test pnpm exec vitest run source/services/models/model-resolution.test.ts source/services/models/model-listing.test.ts source/cli.integration.test.ts` | **55 passed (55)** — 31 unit + 13 listing + 11 integration |
| Pre-fix check: `git stash push` of the two source files, same vitest command | integration: **3 failed / 1 passed** (the 3 new E2E tests); unit: **4 failed / 27 passed** — every regression test catches its bug |
| `pnpm test:provider-black-box` | **19 files passed, 176 passed / 1 skipped (177)** |
| `pnpm test:lane` | same environmental flakiness as the pre-change baseline documented in the review (symlink-`needsApproval` file-tool tests, an Ink timing test, rotating others); every failing file passes standalone and none imports `cli.tsx`/`model-resolution.ts` — e.g. `use-model-selection` + `provider-management-session` + `BottomArea`: **50 passed (50)** in isolation |
