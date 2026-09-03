# Review: `--list-models`

Reviewed `164b8b69` against `c975002e`.

## Findings

### 1. P2 — The production CLI/default collection path is not covered by tests

**Files:** `source/services/models/model-listing.test.ts:11-22,85-121`; `source/cli.tsx:318-334`

The new `runListModels` tests inject both `providerIds` and a `fetcher`. They meaningfully test grouping, filtering, formatting, failure handling, and exit outcomes, but they never exercise the path used by the command: `orderedProviderIds(settingsService, getProviderIds())`. They therefore do not catch regressions in credential gating/order, runtime-provider discovery after `SettingsService` construction, or the default `ModelCatalogSession` to `fetchModels` adapter. There is also no CLI integration assertion that the flag exits before normal session/Ink setup, consumes one positional search term, or reports the command exit status.

This is a coverage gap rather than evidence that the current implementation is wrong. A focused CLI test with controlled settings/provider state, plus one default-dependency `collectProviderModels` test, would close it.

### 2. P3 — Explicitly conflicting standalone flags silently discard `--resume`

**File:** `source/cli.tsx:318-339`

For ordinary invocations there is no positional collision: the list block runs before `resumeTarget` is computed, so `term2 --list-models gpt5` correctly consumes `gpt5` as its search term and never reaches resume handling.

However, `term2 --list-models --resume <conversation-id>` also enters this block. `<conversation-id>` is interpreted as the model search term, the model listing runs, and `--resume` is silently ignored. The same precedence exists for the login errands, so this is consistent with an existing convention, but it is still an ambiguous result, especially because a conversation ID can be a valid fuzzy search string. Consider rejecting `--list-models` with `--resume`, `--fork`, login flags, or other standalone-only options, or documenting the precedence explicitly.

## Confirmed correct

- **Early-exit placement:** `source/cli.tsx:318-334` is before `resumeTarget`, home-directory confirmation, session composition, hooks, profile setup, and `render`; it follows the existing standalone-login pattern. Static imports happen before this point for the same reason they do for login, but no Ink/session startup is performed.
- **Picker source reuse:** `source/services/models/model-listing.ts:31-42` constructs `ModelCatalogSession` and loads through it; the session default fetcher is `fetchModels`. `source/services/models/model-listing.ts:62-64` uses the existing `scoreSubsequence` and `filterModels` primitives. This composes the picker loader/filtering primitives rather than duplicating provider API/catalog logic.
- **`nextProvider` refactor:** `source/services/models/model-catalog-session.ts:9-12,73-80` is behavior-preserving. The extracted helper contains the prior `getAvailableProviderIds` to `providerOrder` to `sortProvidersByOrder` sequence verbatim, and `nextProvider` retains the same empty, missing-current, and wraparound behavior.
- **Live fetch decision:** sound for picker parity. The vendored catalog supplies metadata such as context windows/prices; provider model IDs come from the live provider `fetchModels` path.
- **Settings construction:** sound and limited to the dependencies needed for credential gating and runtime-provider registration. It does retain normal `SettingsService` startup side effects (loading settings and potentially creating/updating the settings file), so it is minimal relative to the required behavior, not side-effect-free.
- **Sequential loads:** sound with the current `ModelCatalogSession` contract. `load` marks an older overlapping request stale, while the listing needs every provider result; sequential loads avoid that race and match the one-provider-at-a-time behavior. The tradeoff is latency, not incorrectness.
- **Tests and lane admission:** the 13 new tests assert meaningful output, filtering, ordering, failure, and exit outcomes; they are not merely call-count tests. Keeping the registry-touching test out of the non-isolated lane is consistent with the manifest documented exclusion of `model-catalog-session.test.ts`; it remains covered by isolated execution.

## Validation

- `pnpm test source/services/models/model-listing.test.ts source/services/models/model-catalog-session.test.ts` — **19 passed**
- `pnpm typecheck` — **passed**
- `git diff --check c975002e..164b8b69` — **passed**
