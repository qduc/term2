# Report: Partial and Fuzzy Matching for `--model` Flag with Interactive Disambiguation

- **Branch**: `model-partial-match` (at commit `b2ff91f6`)
- **Worktree**: `/home/qduc/term2/.worktrees/model-partial-match`
- **Date**: 2026-09-03

---

## 1. Files Changed

1. [`source/services/models/model-resolution.ts`](file:///home/qduc/term2/.worktrees/model-partial-match/source/services/models/model-resolution.ts):
   - Pure model resolution and parsing functions:
     - `parseModelFlag(raw, options)`: Extracts optional thinking-level suffix (`:<effort>`) matching valid reasoning levels, and extracts optional provider prefix (`<provider>/<id>`) matching known providers or explicit CLI `--provider` flag.
     - `matchModels(groups, parsed)`: Implements two-stage matching: exact match precedence across provider model IDs, falling back to partial/fuzzy matching using `filterModels` and `scoreSubsequence`.
     - `formatDisambiguationPrompt(matches, groups)`: Formats matches grouped by provider with provider labels, preserving 1-based sequential numbering.
     - `promptForDisambiguation(matches, groups, pattern, prompter, streams)`: Interactive `readline`-based CLI prompt with re-prompting on out-of-range input and custom stream injection for testing.
     - `resolveModelFlag(deps)`: Coordinates loading provider model catalogs via `collectProviderModels`, match evaluation, silent resolution on exact or single matches, interactive prompt on multi-matches, no-match reporting, and test harness wire passthrough.
2. [`source/services/models/model-resolution.test.ts`](file:///home/qduc/term2/.worktrees/model-partial-match/source/services/models/model-resolution.test.ts):
   - Comprehensive unit test suite (27 tests) testing:
     - Flag parsing (bare patterns, valid thinking suffixes `:low`, `:high`, `:minimal`, non-thinking colon preservation like `:batch`, provider prefix extraction, explicit `--provider` flag priority, unknown slash prefixes).
     - Matching logic (single exact match, multiple exact matches across providers, slash model ID resolution such as `anthropic/claude-3.5-sonnet` on OpenRouter, fuzzy matches, provider scoping).
     - Numbered prompt formatting matching `--list-models` style.
     - Interactive stream prompt and re-prompting on invalid inputs.
     - `resolveModelFlag` resolution flows (silent single match, preserving thinking suffixes, interactive multi-match disambiguation, no-match error, user prompt abort, offline / fetch error fallback).
3. [`source/cli.tsx`](file:///home/qduc/term2/.worktrees/model-partial-match/source/cli.tsx):
   - Updated `--model` flag description to: `Model pattern or ID, supports provider/id and optional :<thinking>`.
   - Wired `resolveModelFlag` directly after provider validation and settings initialization (before `composeAgentRuntime`, `runNonInteractive`, and Ink's `render()`).
   - Handles `no_match` (prints error and exits 1) and `cancelled` (prints `Cancelled.` and exits 1). Updates `settings` with resolved model ID, provider, and extracted reasoning effort (unless overridden by `--reasoning`).
4. [`source/cli.integration.test.ts`](file:///home/qduc/term2/.worktrees/model-partial-match/source/cli.integration.test.ts):
   - Added assertion that `--help` displays the updated `--model` flag description.
   - Added end-to-end integration test asserting that passing a non-matching `--model <pattern>` exits with code 1 and outputs `Error: No models match "<pattern>".`.

---

## 2. Reuse of `model-listing.ts` Logic

- **Model Catalog Loader**: Reused `collectProviderModels` from `source/services/models/model-listing.ts`, ensuring that `--model` queries the exact same providers and model catalogs loaded by `--list-models` (including `ModelCatalogSession`, cached provider listings, and settings-driven provider ordering).
- **Matching Primitives**:
  - Reused `filterModels(models, query)` from `source/services/model-service.ts` and `scoreSubsequence` from `source/utils/subsequence-filter.ts` (the exact primitives used by `filterModelGroups` in `model-listing.ts`).
  - When matching models without a provider constraint, `scoreSubsequence` is run against provider names, and `filterModels` is run against model IDs and names, matching the search behavior of `--list-models [search]`.
- **Grouped Numbered Listing**:
  - Reused the group-by-provider formatting semantics with provider labels (`provider (Label):`) and sequential 1-based numbering (`1) model-id  Model Name`) from `formatModelGroups`.

---

## 3. Judgment Calls & Edge Cases

1. **Exact Match Precedence Over Fuzzy Match**:
   - If a user passes an exact model ID that is a substring of other models (e.g. `--model gpt-5.4`, where the catalog also has `gpt-5.4-mini` and `gpt-5.4-nano`), pure subsequence matching would match all 3 models and trigger an ambiguous prompt.
   - To preserve seamless silent startup for exact IDs, exact ID matches (`model.id.toLowerCase() === pattern.toLowerCase()`) take strict precedence:
     - If exactly 1 exact match exists, it resolves silently without prompting.
     - If multiple exact matches exist (e.g. `gpt-4o` offered by both `openai` and `openrouter`), it prompts to disambiguate specifically among those exact matches.
     - Partial/fuzzy matching only kicks in if 0 exact matches exist.
2. **Provider-Prefixed Model IDs vs Slash in Model Names**:
   - Model IDs like `anthropic/claude-3.5-sonnet` on aggregators like OpenRouter contain slashes.
   - If the prefix before the slash matches a known provider (`getProviderIds()`), it is parsed as a provider prefix unless explicit `--provider` was passed.
   - If the exact slash pattern exists as a model ID in a provider (e.g. `anthropic/claude-3.5-sonnet` on `openrouter`), exact matching matches it directly.
3. **Reasoning Thinking Suffixes**:
   - Only colon suffixes matching valid `reasoningEffort` values (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`) are stripped as thinking suffixes. Other colons (such as `:batch` or custom versions) are preserved as part of the model name.
   - Explicit CLI flag `-r, --reasoning <effort>` takes precedence over suffix-extracted reasoning effort.
4. **Offline & Test Harness Wire Passthrough**:
   - If the provider encounters a network/fetch error when loading models and yields 0 models (e.g. offline usage or custom provider without a `/models` endpoint), the model ID is passed through rather than halting startup.
   - In isolated test harness children (`TERM2_HARNESS_IDLE_PATH`), simulated wire fixtures do not mock catalog endpoints; the model ID passes through silently to allow turn wire replay tests to execute.
5. **Prompt Seam & Stdin Ownership**:
   - `resolveModelFlag` runs in `cli.tsx` after `SettingsService` initialization and provider validation, but before `composeAgentRuntime` and Ink's `render()`. This ensures standard `readline` prompt ownership without conflicting with Ink's terminal raw mode.
   - If the user aborts stdin (`Ctrl+C` or EOF / closed stream), resolution yields `status: 'cancelled'`, outputs `Cancelled.`, and exits with code 1.

---

## 4. Test Execution & Pass/Fail Output

### A. Unit Tests (Model Resolution & Model Listing)
```bash
pnpm test source/services/models/model-resolution.test.ts source/services/models/model-listing.test.ts
```
**Output**:
```
 RUN  v4.1.9 /home/qduc/term2/.worktrees/model-partial-match

 Test Files  2 passed (2)
      Tests  40 passed (40)
   Start at  21:33:19
   Duration  780ms
```
*(All 27 new tests in `model-resolution.test.ts` passed; all 13 existing tests in `model-listing.test.ts` passed).*

### B. Integration Tests (CLI)
```bash
pnpm test source/cli.integration.test.ts
```
**Output**:
```
 RUN  v4.1.9 /home/qduc/term2/.worktrees/model-partial-match

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  21:26:10
   Duration  7.70s
```
*(All 8 CLI integration tests passed, including new `--help` and no-match error tests).*

### C. TypeScript Typecheck
```bash
pnpm typecheck
```
**Output**:
```
$ tsc --noEmit
Done in 392ms using pnpm v11.7.0
```
*(Exit code 0).*

### D. Provider Black-Box Suite
```bash
pnpm test:provider-black-box
```
**Output**:
```
 Test Files  19 passed (19)
      Tests  176 passed | 1 skipped (177)
   Start at  21:30:17
   Duration  66.25s
```
*(All 19 black-box test files passed cleanly).*

### E. Lane Test Suite
```bash
pnpm test:lane
```
**Output**:
```
 Test Files  475 passed (475)
      Tests  6394 passed | 3 expected fail (6397)
   Start at  21:32:50
   Duration  17.96s
```
*(All 475 test files and 6,394 tests passed).*
