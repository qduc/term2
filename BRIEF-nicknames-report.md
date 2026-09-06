# Report: model nicknames (feature 2 of 2)

Worktree: `/home/qduc/term2/.worktrees/model-nicknames`, branch `model-nicknames`. Nothing outside this worktree was touched. TDD throughout: every wave started with failing tests, confirmed red for the right reason, then implemented to green.

## What was built

**Setting** — `agent.modelNicknames`: map of short name -> `"provider/modelId"` (+ optional `:effort` suffix), split on the FIRST `/` by reusing `model-favorites.ts` helpers (`parseFavoriteEntry`/`serializeFavorite`) as instructed. Wired per `setting-wiring`: zod schema (`record(string, string)`, default `{}`), `SETTING_KEYS.AGENT_MODEL_NICKNAMES`, `SettingWithSources`, `settings-sources.ts` mapping, default, runtime-modifiable, completion description, `models` category, Contract 04 consumer inventory group, inventory count test 147 -> 148.

**Validation** (all tested) — identifier charset `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`, max 64: rejects `/` (provider-prefix parse), `:` (effort suffix), leading `-` (flag parse), whitespace/quotes/shell metacharacters, the reserved `favorites` sentinel, provider-id collisions (case-insensitive), and duplicate names (case-insensitive). Catalog-id collisions are NOT rejected at creation (needs a catalog; unavailable offline) — resolution precedence covers that instead. `setNicknameTarget` refuses to re-point a live name at a different target (any case) — no silent nickname stealing; rename (same target) and case-rewrite (same name+target) are allowed.

**Resolution** — `resolveModelFlag` checks nicknames BEFORE favorites and before any catalog load: exact case-insensitive hit resolves with ZERO fetcher calls. Precedence tested: exact nickname > favorite > exact real model id (a shadowed real id stays reachable as `provider/id`). Stored `:effort` applies when the flag carries none; an inline `-m op:low` suffix overrides it. An explicit `--provider` (or a provider prefix inside the flag) scopes eligibility to targets on that provider; nicknames equal to a registered provider id are excluded at lookup. A vanished target in a WARM cache falls through to full catalog resolution with a `warnings` entry (mirrors the favorites path via `peekCachedModels`); a cold cache trusts the nickname — accepted, tested limitation. `passthrough` statuses, `HARNESS_IDLE_ENV`, and provider-narrowing semantics untouched.

**New modules** — `source/services/models/reasoning-effort.ts` (shared `VALID_REASONING_EFFORTS` + suffix stripping; avoids a resolution<->nicknames import cycle; `model-resolution.ts` re-exports the constants for existing importers) and `source/services/models/model-nicknames.ts` (parse/serialize/entries/labels/validate/set/find).

**UI (Favorites tab only)** — `ctrl+n` opens an inline editor bound to the highlighted row; the draft owns printable input, backspace, Enter, Escape. Rejected input shows the reason inline and stays open; valid commit persists, closes, and refreshes row labels. Esc cancels to the untouched filter text; a second Esc closes the menu. `ctrl+f` stays live — un-favoriting the row auto-closes the editor (hook effect). Tab/provider cycling/list navigation are suspended while the draft is open (the editor is bound to one row; navigation would orphan it). Existing nicknames render as `— aka "nick"` on rows on every tab; the `ctrl+n` footer hint is Favorites-only; provider tabs ignore the command. Implemented across `menu-types.ts`, `MenuSurface.tsx`, `ModelMenuSession.tsx`, `use-model-selection.ts`, `ModelSelectionMenu.tsx`.

**Independence kept** — separate key; nicknaming never requires favoriting and vice versa; un-favoriting never deletes a nickname (tests cover the toggle path with a nickname present).

## Verification (actual output)

Focused gate, all touched + adjacent files:

```
Test Files  12 passed (12)
     Tests  271 passed (271)
```

`tsc --noEmit`: clean (exit 0). `eslint` on the 19 touched files: `0 errors, 4 warnings` — all four are in pre-existing code (`ModelMenuSession.tsx` useMemo deps, `ModelSelectionMenu.tsx` credential memo, `use-model-selection.ts` favoritesRevision dep + set-state-in-effect at the pre-existing load effect); verified identical at baseline by stashing the change set and rerunning. Prettier applied to every touched file.

`pnpm test:related` (12 changed source files):

```
Test Files  3 failed | 210 passed | 1 skipped (214)
     Tests  5 failed | 3559 passed | 2 expected fail | 2 skipped (3568)
```

The 5 failures are the SAME tests that fail with the change set stashed (verified via `git stash`):

```
FAIL scripts/nested-approval/scripted-adapter.acceptance.test.ts > drives one real session turn ...
FAIL source/tools/file/apply-patch.test.ts > needsApproval: requires approval for outside workspace
FAIL source/tools/file/apply-patch.test.ts > needsApproval: requires approval for a symlink target outside the workspace
FAIL source/tools/file/search-replace.test.ts > needsApproval requires approval for a symlink target outside the workspace
FAIL source/tools/file/search-replace.test.ts > needsApproval requires approval for anchor recovery outside the workspace
```

Full isolated suite (`pnpm test`):

```
Test Files  3 failed | 614 passed | 1 skipped (618)
     Tests  5 failed | 8186 passed | 3 expected fail | 2 skipped (8196)
```

Same 5 pre-existing failures; zero regressions.

`pnpm test:lane` (two runs, illustrating the documented flakiness):

```
run 1: Tests  3 failed | 6550 passed | 3 expected fail (6556)
       + logging-service.test.ts ENOENT (/tmp/.../term2-2026-09-06.log)
run 2: FAIL source/tools/file/search-replace.test.ts > needsApproval ... (x2, pre-existing env)
       FAIL source/hooks/use-first-run-setup.test.tsx > opens provider management ...
       FAIL source/services/providers/provider-management-session.test.ts > ... (x3)
```

Different random failures per run as the brief predicts; no nickname-related file ever failed.

## TDD notes / corrections the tests forced

- First `setNicknameTarget` draft allowed re-pointing a live name at a different target; the duplicate-rejection test caught it — steal protection added, plus case-variant tests.
- `parseModelFlag` suffix parsing moved to `reasoning-effort.ts` with a re-export so `model-favorites`/`model-resolution` importers stay source-compatible.
- Session-level tests must dispatch one event per act block: the menu interaction closure re-registers only after React commits, so batched dispatches leak input into the filter query (matches real keystroke timing).

## Files changed

New: `source/services/models/model-nicknames.ts`, `source/services/models/reasoning-effort.ts`, `source/services/models/model-nicknames.test.ts`.
Modified: `model-resolution.ts` + test, `use-model-selection.ts` + test, `ModelSelectionMenu.tsx` + test, `ModelMenuSession.tsx` + test, `menu-types.ts`, `MenuSurface.tsx`, `menu-system.integration.test.tsx`, `settings-schema.ts` + test, `settings-sources.ts`, `settings-completion-config.ts`, `settings-consumer-inventory.ts`.

Diff: 16 files modified, 4 added; +~1240/-18 lines plus the new modules/tests.
