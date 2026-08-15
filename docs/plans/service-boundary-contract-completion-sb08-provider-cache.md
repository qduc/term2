# SB-08 Provider-Cache Coherence — Retained-Red Audit and Repair

Status: **repaired (SB-08c); the retained public hook proof is green and the
ordinary red was re-observed on it first.** The repair is a production change
to `SettingsService` plus two test files; the Contract 04 extension material
below remains an audit draft only. No Contract 04 record edit, coordinator-tracker
edit, commit, merge, push, or staging is included.

## Scope and boundary

This packet tests the user-visible model-selection boundary in
`useModelSelection`, using an isolated real `SettingsService` subscription and
the ordinary model-menu opening path. It does not call `ModelCatalogSession.clear()`
directly as the behavior under test.

The proof constructs `SettingsService` before registering a unique provider,
seeds the same credential-ready loopback custom-provider entry, loads response A
once, persists the same provider ID with a changed base URL through
`setPersistentDynamic('providers', ...)`, and reloads with response B. The
provider fetch count is asserted at the initial seed and after the reload.
The post-change compact `{ fetchCount, modelIds }` assertion precedes the
separate model-list B assertion, and the test finally unregisters its unique
provider. The test was retained as `it.fails.sequential(...)` after the ordinary
`it` version visibly failed with stale A at the hook boundary; SB-08c flipped it
back to an ordinary `it` (renamed to assert the repaired behavior), re-observed
the same stale-A failure, and then made it green with the repair below.

## Finding (unchanged defect record)

The ordinary proof failed with:

```text
AssertionError: expected `{ fetchCount: 1, modelIds: ['model-a'] }` to deeply equal `{ fetchCount: 2, modelIds: ['model-b'] }`
```

The settings listener did run and the hook reopened its load path, but the
post-change fetch count remained 1 and the model IDs remained A. The
process-global `fetchModels()` cache remained keyed by provider ID. The model
picker therefore presented stale A after a successful same-ID custom-provider
configuration change. This is a product defect: the picker can remain stale
until explicit refresh or restart. It is not the missing-credentials branch;
the loopback custom provider is credential-ready, and explicit refresh is a
separate invalidating path.

## Repair (SB-08c)

### Owner decision: the provider-update/cache ownership boundary is the settings `providers` persistence point

The repair lands in `SettingsService` at the `providers` mutation point
(`setPersistentDynamic('providers', ...)`, plus `reset` when it touches
`providers`), and invokes the cache-ownership primitive
`clearModelCache(providerId)` from `model-service.ts` per affected provider ID.
Evidence that this is the actual provider-update/cache ownership boundary and
not an arbitrary component effect:

- Every runtime provider update in the product commits through
  `setPersistentDynamic('providers', ...)`: `saveProvider` and
  `deleteCustomProvider` (`provider-service.ts`) delegate their persistence to
  that single call, and the retained public proof drives the same boundary.
  There is no other production mutation path for the persisted provider list.
- The settings service already owns the persisted provider-configuration domain:
  it validates/normalizes the list (`validateAndApplySetting` against
  `SettingsSchema`) and registers runtime providers from it at startup
  (`registerRuntimeProviders`), and it already owns key-specific live effects at
  the settings boundary (`logging.logLevel`, `logging.suppressConsoleOutput`,
  and coupled sandbox/auto-approve normalization).
- The hook's existing `providers` handler is deliberately left as a session-local
  `ModelCatalogSession.clear()` plus revision bump. The repair is not placed
  there because the component effect cannot know which provider IDs changed
  without re-deriving the diff, and process-global cache coherence belongs where
  the update commits, not in the consumer that merely observes it.

### Invalidation scope: narrow, diff-based, per provider ID

`invalidateChangedProviderModelCaches(previous, next)` indexes the old and new
provider lists by `resolveProviderId` and evicts exactly the IDs whose entry was
added, removed, or changed under the same ID (canonical JSON comparison, key
order-insensitive). Unaffected provider IDs keep their cached model lists, and
there is no `cache.clear()` / global wipe anywhere in the repair. The same
handling covers `reset('providers')` and full `reset()` (each previously
configured ID evicted individually).

### Post-repair evidence

- The flipped ordinary hook proof passes: after the same-ID base-URL change, the
  post-save selection path re-fetches (`fetchCount: 2`) and presents model B.
- New narrowness test in `model-service.test.ts`: a `providers` config change
  evicts only the changed provider's cache entry (`changedFetches` 1 → 2) while
  an untouched provider's cache survives (`keptFetches` stays 1), proving both
  the per-ID eviction and the absence of a global wipe.

### Sibling cache-key and invalidation audit

Cache-keyed model/catalog state in this codebase and its invalidation owners:

| Cache | Key | Invalidation owner(s) |
| --- | --- | --- |
| `model-service.ts` `cache` (process-global model lists) | provider ID only (no config revision) | `clearModelCache(provider?)`; now also per-affected-provider at the settings `providers` boundary (this repair); per-credential-change via `ModelCatalogSession.invalidate` |
| `ModelCatalogSession.#modelsByProvider` (per-open session model lists) | provider ID | `clear()` on `providers` change / open; `invalidate(provider)` at credential boundaries; `refresh(provider)` on explicit refresh |
| `AgentChatService.#modelCache` (streamed model instances) | `providerId\0modelId` | `clearModelCache()` wholesale on `onConfigChanged`/`setProvider`/`dispose` — session-bound, and its key carries no config revision, so the wholesale clear there is the narrow owner action for that cache |
| `AgentChatService`/`agent-client` codex `fetchModels` calls | delegate to `model-service` cache | same as first row |
| Provider registry (`registry.ts` `providers` Map) | provider ID (definitions, not models) | `upsertProvider`/`unregisterProvider`/`registerProvider` — no model-cache responsibility |

Key-design note: `fetchModels` keying by provider ID alone is the root cause;
the repair chose boundary-side eviction over adding a credential/configuration
revision to the cache key, because a revision key would leak entries unless
evicted anyway and would move cache-key derivation away from the boundary where
the update commits. The cache-key design remains a documented alternative, not
the repair.

## Proposed Contract 04 extension (not yet owned or integrated — audit draft only)

Propose the following row for the Contract 04 discussion:

> A successful runtime/persisted custom-provider configuration change invalidates
> the effective model-catalog value at the model-selection boundary before the
> next load.

Keep registry mutation and custom-provider persistence in that same proposed
Contract 04 discussion. This record does **not** claim the behavior is already
owned by C4.3 or C4.4, and does **not** claim it belongs to the normal
runtime-modifiable setting inventory. `SENSITIVE_SETTING_KEYS` also does not
currently list custom-provider API keys.

SB-08c does not integrate or claim this row: the repair implements the behavior
at the settings boundary, but the contract-text ownership question (which
boundary the row names, and whether the model-catalog boundary belongs in the
Contract 04 discussion at all) remains an owner decision recorded here only.

## Verification record

Focused test files for the gates:

- `source/hooks/use-model-selection.test.tsx`
- `source/services/models/model-catalog-session.test.ts`
- `source/services/model-service.test.ts`
- `source/providers/provider-service.test.ts`

Commands were run from the isolated worktree using `pnpm --dir
/home/qduc/term2/.worktrees/sb08-provider-cache` and `NODE_ENV=test` for tests.

- Ordinary red re-observation on the flipped (renamed) ordinary `it`, before the
  repair:
  `NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache test source/hooks/use-model-selection.test.tsx --testNamePattern="invalidates the changed custom provider"` — **failed as intended with the documented stale-A failure: 1 failed, 13 skipped** (`expected { fetchCount: 1, modelIds: ['model-a'] } to deeply equal { fetchCount: 2, modelIds: ['model-b'] }`).
- Repaired focused gate:
  `NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache test source/hooks/use-model-selection.test.tsx source/services/models/model-catalog-session.test.ts source/services/model-service.test.ts source/providers/provider-service.test.ts` — **4 files passed; 73 passed (72 before + the new narrowness test)**.
- Changed-owner suite (settings): `NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache test source/services/settings/settings-service.test.ts source/services/settings/settings-schema.test.ts` — **89 passed, 1 failed (90 total)**; the single failure is the known pre-existing schema baseline below, verified unchanged at base `11758c77`.
- Typecheck: `pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache typecheck` — **passed** (`tsc --noEmit`).
- Prettier: `pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache exec prettier --check source/hooks/use-model-selection.test.tsx source/services/model-service.test.ts source/services/settings/settings-service.ts docs/plans/service-boundary-contract-completion-sb08-provider-cache.md` — **passed; all four files formatted**.
- `git -C /home/qduc/term2/.worktrees/sb08-provider-cache diff --check` — **passed** with no output.
- Full suite: `NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache test` — **failed only on the pre-existing settings-schema baseline** (counts recorded at the time of the run; the SB-08 red is no longer among them).

The full-suite baseline was isolated separately with
`NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-provider-cache test source/services/settings/settings-schema.test.ts`:
**28 passed, 1 failed (29 total)**. Its unrelated failure is
`disables the model-request wall-clock deadline by default while allowing an
explicit limit` (`expected 0, received 300000`); it is present at base
`11758c77` and untouched by this diff.

The provider black-box suite was not required or run: this repair changes
`SettingsService` and tests, not a provider, bridge, run loop, registry, or
non-interactive production path. Any later change to those owners must run
`NODE_ENV=test pnpm test:provider-black-box`.

## Isolation

Only these files are permitted in this worktree diff:

- `source/hooks/use-model-selection.test.tsx`
- `source/services/model-service.test.ts`
- `source/services/settings/settings-service.ts`
- `docs/plans/service-boundary-contract-completion-sb08-provider-cache.md`

No other production source is changed; the Contract 04 contract record
(`docs/contracts/04-settings-consumption.md`) is not edited.
