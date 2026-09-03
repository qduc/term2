# Report: `--list-models [search]` CLI flag

Branch: `list-models` @ `164b8b69` (worktree `.worktrees/list-models`). Not merged to main, per instructions.

## Files changed

- `source/cli.tsx` — new `listModels` boolean flag in the meow `flags:` block; help-text option line + two examples; standalone-errand early-exit block directly after the `--codex-login` block (prints and `process.exit`s before any Ink render, session, profile, SSH, or hook setup).
- `source/services/models/model-listing.ts` — **new**: the shared model-listing module (collect / filter / format / orchestrate, see below).
- `source/services/models/model-catalog-session.ts` — extracted `orderedProviderIds()` (credential gating + `providerOrder` sort) and rewired `nextProvider()` to use it, so the picker and the CLI share one ordering implementation. Behavior identical.
- `source/services/models/model-listing.test.ts` — **new**: 13 unit tests for filtering, formatting, ordering, and the `runListModels` outcome contract.

## Where the shared helper lives

`source/services/models/model-listing.ts`. It does not invent a second source of truth; it composes the exact primitives the interactive `/model` picker (`use-model-selection.ts`) uses:

- `ModelCatalogSession` (the picker's loader) → `fetchModels` in `model-service.ts` for per-provider model lists, so context-window enrichment and fetch semantics match the picker.
- `orderedProviderIds()` from `model-catalog-session.ts` (extracted from `nextProvider`) for which providers are listed and in what order: credential-gated via `getAvailableProviderIds`, ordered by `providerOrder`.
- `filterModels` + `scoreSubsequence` for search, i.e. the picker's own fuzzy matcher. A search matching a provider id keeps that provider's whole list; otherwise it filters models within each provider.

`runListModels()` returns a structured outcome (`{ exitCode, output, error, warnings }`) and never touches stdout/stderr itself, so cli.tsx stays a thin printer and the whole contract is unit-testable.

## Test commands run and results

| Command | Result |
| --- | --- |
| `pnpm test source/services/models/model-listing.test.ts source/services/models/model-catalog-session.test.ts` | **19 passed** (13 new + 6 existing). Initially red before implementation (module absent), per TDD. |
| `pnpm test:related ./source/services/models/model-listing.ts ./source/services/models/model-catalog-session.ts` | **216 passed, 1 skipped** (20 files) |
| `pnpm typecheck` | clean |
| `pnpm exec prettier --check` + `pnpm exec eslint` on all 4 changed files | clean (prettier had re-wrapped one line in `model-listing.ts`; re-verified after) |
| `pnpm test:lane` | **4 pre-existing failures, unrelated to this diff** (see below); 473 files / 6380 tests passed |
| Live smoke: `pnpm exec tsx source/cli.tsx --list-models` | 7 providers printed grouped, exit 0 (~15 s, live /models fetches) |
| Live smoke: `--list-models gpt5`, `--list-models zai` | fuzzy model-id match and provider-id match both correct, exit 0 |
| Live smoke: `--list-models zzznothing` | stderr `No models match "zzznothing".`, exit 1 |
| Live smoke: `--list-models foo bar` | stderr `Error: --list-models accepts at most one search term.`, exit 1 |
| Live smoke: `--help` | new option line + examples render |

### `pnpm test:lane` failures are pre-existing (verified, not caused by this change)

The lane failed 4 tests in `source/tools/file/create-file.test.ts` and `source/tools/file/search-replace.test.ts` (symlink / outside-workspace approval containment) plus 1 unhandled ENOENT from `logging-service.test.ts`. Baseline check: running those two files in **isolation on the main checkout at `c975002e` — the exact commit this branch cut from — produces the same 4 failures with none of my changes applied**. No lane test imports `cli.tsx`, `model-listing.ts`, or the changed export path (`model-catalog-session.test.ts` is itself lane-excluded), so my diff cannot reach them. Left alone per repo policy on pre-existing failures; worth a separate look (they smell environment-sensitive: file-containment resolution under this machine's tmp/workspace layout).

### New test file deliberately NOT admitted to the lane manifest

`.github/vitest.lane.safe.txt` excludes `source/services/models/model-catalog-session.test.ts` for "cross-file leakage observed non-isolated (leak-union 2026-08-29)". My test imports the same module graph (→ `providers/index.js`, which mutates the global provider registry on import) and one test registers/unregisters fake providers. Admitting it would re-introduce the documented leak class, so it stays isolated-suite-only (the isolated full suite remains the handoff/CI authority per AGENTS.md).

## Design decisions made without a spec

1. **Live fetch, not the vendored static catalog.** `catalog.generated.ts` is metadata (context windows/prices), not the picker's list; the picker's list is the live `fetchModels` per provider. Agreement with the picker (the stated requirement) therefore means network calls. Consequence: `--list-models` costs ~5–15 s and shows only what the picker could show.
2. **Settings are constructed in the early-exit block.** The login errands run before any settings because a fresh host has none; `--list-models` cannot avoid settings because availability is credential-gated. I construct only the minimal `LoggingService` + `SettingsService` (same construction as the normal path) and still skip all "heavy" setup (SSH, hooks, history, profile resolution, conversation, Ink).
3. **Search term = one positional.** `term2 --list-models gpt5` consumes `cli.input[0]`; more than one positional errors out (`accepts at most one search term`), mirroring `--resume`. The block exits before resume/prompt positional handling, so no collision. Combined with other flags (e.g. `--resume`), `--list-models` silently wins, matching how the login flags behave.
4. **Provider-id match keeps the whole provider group**; otherwise the search filters models within each provider; groups left empty are dropped. Fuzzy subsequence matching (same scorer as the picker) rather than plain substring — the task allowed either, and picker parity argued for the picker's matcher.
5. **Failed providers degrade to stderr warnings**, never abort the listing; exit 1 only when nothing is printable (no providers, all listings failed, or no search matches).
6. **Sequential provider loads.** `ModelCatalogSession.load` marks overlapping loads stale by design; parallel collection would race itself. Sequential matches how the picker actually loads (one provider at a time).
7. **Output format**: `provider (label):` header, two-space-indented `model-id`, name appended only when it differs from the id; labels/names omitted when they duplicate ids. Model order = API order, same as the picker.
8. **Exit codes**: 0 with output; 1 for no results / no available providers / more than one search positional.
