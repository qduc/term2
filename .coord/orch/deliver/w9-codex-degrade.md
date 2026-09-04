# Codex model listing degrades to a single `gpt-5.3-codex` entry and is cached for an hour

**Diagnosis only — no fix applied.** Written 2026-09-04 ~21:30 +07, worktree `w9-codex`.
Symptom: `term2 -p codex -m gpt-5.6-luna` fails locally with `Error: No models match "gpt-5.6-luna".`
observed twice on 2026-09-04 (~20:12, ~20:45 local) while
`~/.cache/term2-nodejs/models/codex.json` held exactly one model, `gpt-5.3-codex`.

**One-line answer:** the upstream `chatgpt.com/backend-api/codex/models` endpoint
occasionally answers **HTTP 200 with a legacy/fallback one-model body**; the local code
cannot distinguish that from a good listing and — since the 1-hour disk cache landed on
**2026-09-03** — persists it across processes, while the `--model` validation that also
landed on 2026-09-03 turns the poisoned list into a hard local failure. Both enabling
behaviors shipped together in **v0.21.0 (2026-09-03)**, one day before the first observed
failure. The degraded response itself is upstream-side and was **not** reproducible during
this investigation (0 of 25 controlled refetches).

---

## Q1 — Where does the single-entry `gpt-5.3-codex` list come from?

**Proved: it is a genuine upstream response body, faithfully mapped and cached. There is
no hard-coded fallback and no filter that drops models.**

The full path for `-p codex -m <model>` (non-interactive):

1. `source/services/models/model-resolution.ts:314` → `collectProviderModels`
2. `source/services/models/model-listing.ts:23-58` → `ModelCatalogSession.load(provider)`
3. `source/services/models/model-catalog-session.ts:35` — the fetcher is
   `fetchModels` from `source/services/model-service.ts`
4. `source/services/model-service.ts:189-192` → `getProvider('codex').fetchModels` =
   `fetchCodexModels` (`source/providers/codex.provider.ts:737`)

Inside `fetchCodexModels` (`source/providers/codex.provider.ts:401-452`):

- `:419` — GET `https://chatgpt.com/backend-api/codex/models?client_version=<v>`
- `:423-425` — a non-2xx **throws** (`Codex models request failed (<status>)`); it does not
  substitute a default list
- `:427-428, :444-451` — `body.models` is mapped 1:1 (`slug`/`model` → `id`); whatever
  array upstream sends is exactly what comes back

So a one-entry body (`models: [{slug: "gpt-5.3-codex", …}]`) is the only way a one-entry
list reaches the cache. The only hard-coded `gpt-5.3-codex` in the file is
`DEFAULT_CODEX_MODEL` (`codex.provider.ts:32`), used **only** as the streaming default
model (`:419` — `getStreamedModel`), never returned by the listing. Grep for a fallback
array in the installed CLI's bundle confirms the same: `dist/providers/codex.provider.js:339-356`
throws on `!ok` and contains no default listing.

**Not the client_version gate either.** `resolveCodexClientVersion`
(`codex.provider.ts:287-337`) feeds the URL a version resolved as local `codex --version`
→ npm `@openai/codex/latest` → hard fallback `0.133.0` (`:257`), cached 24 h in
`~/.cache/term2-nodejs/codex-client-version.json`. Probing the endpoint directly
(read-only, same request the app makes) gives a clear version-tier map:

| client_version | models returned |
| --- | --- |
| 0.150.0–0.153.2 | 9 (gpt-reserve, 5.6-sol/terra/luna, 5.5, 5.4, 5.4-mini, 5.3-codex-spark, codex-auto-review) |
| 0.133.0 / 0.140.0 | 5 (5.5, 5.4, 5.4-mini, 5.3-codex-spark, codex-auto-review) |
| 0.100.0 / 0.120.0 | 4 |
| 0.80.0 | 0 |
| unknown (0.0.0) | 9 (full latest set) |

**No tier returns a one-model `gpt-5.3-codex` list**, and `gpt-5.3-codex` appeared in no
response at all (29 probes). And today every fetch — degraded or not — used the *same*
cached `0.153.0`: the version cache was written 2026-09-04 07:30:44 (+07, mtime and
embedded timestamp) with a 24 h TTL, so it was valid at 20:12/20:45 and no process
rewrote it in between.

**Inferred (not proved):** the one-model body is the backend's legacy/fallback model set —
`gpt-5.3-codex` being the long-standing default codex model — served by some upstream
condition (partial deployment/failover). I could not find any request I control that
reproduces it.

## Q2 — Since when?

**The degraded upstream response is presumably old; the user-visible failure mode started
2026-09-03.** Evidence:

- `c4ac6bd7` (2026-05-24, "feat: add chatgpt codex auth") introduced the models fetch
  *and* the `client_version` parameter — old, not the trigger.
- Before `64b1d284` (2026-09-03 22:06 +07, "feat(models): add 1-hour atomic disk cache for
  model listings"), `fetchModels` had **only the in-memory Map** (verified via
  `git show 64b1d284^:source/services/model-service.ts` — a single `cache = new Map()`,
  no disk). A degraded response poisoned at most one process, which died at command end.
  Relevant hunk added by `64b1d284`:
  `+export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour`, `+function readDiskCache(`,
  `+function writeDiskCache(`, and in the miss path `writeDiskCache(provider, models, …)`.
- Same day, `164b8b69` ("Add --list-models CLI flag…") and `b2ff91f6`/`ad47f856`
  ("partial and fuzzy matching … for --model"; "keep --model session-only…") added local
  validation of `-m` against the listing, including the hard error — before this, `-m`
  passed through to the provider unvalidated and a degraded listing was **invisible**.
- All of the above shipped in **v0.21.0, dated 2026-09-03** (installed CLI:
  `~/.local/share/pnpm/global/v11/52a5-19fe4dfc63f/.../@qduc/term2`, changelog: "Added
  1-hour atomic disk caching for provider model listings…", "model flag improvements:
  --list-models … plus partial and fuzzy matching … for --model"). Shell history shows the
  user first exercising `--model`/`--list-models` on 2026-09-03 20:40 and 23:52 — right
  after it landed.
- First observed failures: **2026-09-04 ~20:12 and ~20:45** — one day later. App log
  `term2-2026-09-04.log.2` shows process starts at exactly 20:12:24/20:12:29 and 20:45:20,
  and a good refetch at 21:07 matching the cache rewrite at 21:07:57.

## Q3 — What triggers the degraded path?

**Proved — it is none of the local suspects:**

- **Not auth expiry / refresh failure:** `getOrRefreshAccessToken` throwing would propagate
  out of `fetchModels` (`model-service.ts:202-222` logs `Failed to fetch models` and
  rethrows) and `model-resolution.ts:330-339, 344-356` would then **fail open**
  (passthrough) — you would never see "No models match". There are **zero** warn/error
  fetch entries in `term2-2026-09-04.log.2` (covers 16:47–21:13, all providers' sessions).
- **Not a 4xx/5xx or rate limit:** same as above — non-2xx throws, never caches
  (`codex.provider.ts:423-425`). And 20 back-to-back requests at ~2 s spacing were all 200.
- **Not a response-shape change:** a missing/non-array `models` yields `[]`
  (`codex.provider.ts:430-441`), and an empty list plus a fetch *error* both pass through
  at resolution — the observed cache held one *valid* model entry, so `body.models` was a
  well-formed one-element array.
- **Not client_version:** see Q1 — the cached `0.153.0` was in effect for the whole day and
  returns the full 9-model set (verified 25+ times).
- **Not CDN cache:** `cf-cache-status: DYNAMIC` on every probe (HKG POP).
- **Reproduction failed:** 0/20 degraded in a 50 s loop at 21:17–21:18 (same
  client_version, same token path, same URL construction as `fetchCodexModels`), 0/5
  degraded through the real CLI (`--list-models codex` after each cache clear,
  21:23:36–21:23:51), plus 9 version-variant probes (one transient local `fetch failed`
  at 0.145.0 — which, note, would *also* have been harmless: it throws, never caches).
  The upstream condition that produced the 20:12/20:45 bodies had subsided by 21:17.

**Inferred:** an intermittent upstream-side condition serving a legacy one-model set.
Because successful listing fetches are completely silent locally (see Q4), the condition's
real-world frequency cannot be reconstructed from logs.

## Q4 — Is the bad result cached like a good one?

**Yes — proved, and this is the core defect.** `source/services/model-service.ts:193-201`:
whatever array the provider returns is written to the in-memory Map **and** to the atomic
disk cache with a fresh timestamp and the full 1 h TTL — no minimum-count check, no
diff against the previous list, no "degraded" marking. Two aggravators:

- The write is **silent** (only failures log), so a poisoned `codex.json` leaves no trace
  in the logs; you cannot tell from logs which process wrote it or when.
- The **L1 memory cache has no TTL** (`model-service.ts:171` — `cache.has(cacheKey)` with
  no timestamp check): inside a long-running process the poisoned list survives even past
  the disk TTL.

Contrast: an *error* path is handled correctly (`:202-222` rethrows; resolution fails open)
— only the "200 but wrong body" case poisons, and it poisons for an hour across all
processes on the host.

## Q5 — Failure rate (measured)

- **Live controlled refetches, 21:17–21:26 local, 2026-09-04: 0 degraded / 25**
  (20 direct fetch-level probes + 5 real-CLI `--list-models codex` runs, each preceded by a
  cache clear). All 200, 9 models, client_version 0.153.0.
- **Real traffic, same evening:** ≥2 degraded fetches (the two poisoned cache writes behind
  the 20:12 and ~20:45 failures — at least one fresh degraded fetch between 20:12 and
  20:45 after the user's first clear, plus at least one earlier that day). Total fetch
  count in that window is unknowable because successful fetches are unlogged; a per-fetch
  rate therefore cannot be honestly computed. "2 poisoned hours within one evening, first
  day after the feature shipped" is the defensible statement.

## Recommended fix (stated as a change I did **not** make)

1. **Last-known-good guard in `fetchModels`** (`model-service.ts:193-201`): before
   `writeDiskCache`, compare the fresh list with the still-valid previous disk list; if the
   new list is a strict subset that would drop models the user was using minutes ago
   (simplest robust rule: new list is a strict subset of the previous one), keep serving
   the previous list, skip the write, and log a warning. This converts "hour of hard
   failures" into "one stale-but-complete list".
2. **Self-heal on no-match** (`model-resolution.ts:343-361`): before returning `no_match`,
   if the candidate list came from cache, force one network refetch (bypass L1/L2) and
   retry the match once.
3. **Observability:** log one line (provider, model count) on every *network* listing
   fetch. Today a degraded fetch is invisible, which is why this had to be reconstructed
   from cache files and absence of warnings.
4. Minor: give the L1 memory cache the same 1 h TTL as the disk layer.

Containment only — the trigger is upstream (OpenAI's codex backend serving a legacy
one-model list); worth reporting upstream with the captured timeline if it recurs.

## Proved vs inferred

**Proved** (code read, git history, logs, live probes): no fallback list or filter locally;
exact error emission path; 200-with-one-model body as the only possible local cause;
error paths never cache; disk cache persistence + silent write; memory cache without TTL;
client_version tier map and its non-involvement today; all enabling commits on 2026-09-03
in v0.21.0; log silence at 20:12/20:45; 0/25 live reproduction.

**Inferred:** the upstream legacy/fallback nature of the one-model body and its trigger
condition (unobservable from here); that the degraded responses have occurred before
2026-09-04 without being noticed (plausible but unproven — they were invisible pre-0.21.0).

## Actions taken on shared state (constraint compliance)

- Deleted `~/.cache/term2-nodejs/models/codex.json` exactly **5 times**: 21:23:36, 21:23:39,
  21:23:43, 21:23:48, 21:23:51 (+07), each immediately repopulated by a
  `term2 --list-models codex` refetch. No other file under `~/.cache` was deleted or
  rewritten (the 21:07–21:08 mtimes on other providers' cache files predate this
  investigation and belong to concurrent sessions). `codex-client-version.json` was only
  read.
- ~34 read-only GETs to `chatgpt.com/backend-api/codex/models` (21:17–21:26) using the
  app's own `CodexTokenManager` — the same request `fetchCodexModels` makes. No credential
  file was read into output, modified, logged in/out; no tokens or account ids printed.
