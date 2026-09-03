# Independent Review: Model Disk Cache

**Reviewed:** branch `model-disk-cache`, commit `2bdee3c6` (implementation in `64b1d284`)
**Reviewer scope:** code review + test reproduction only; no source edits.
**Method:** full read of the diff (`ce7a8e32..64b1d284`), trace of every invalidation call site, and independent re-execution of all five claimed test commands, plus a standalone cross-process stress of the write pattern.

---

## Summary

The implementation is solid. The atomic write is correct by construction (not just present), TTL/clock-skew handling cannot serve stale disk data, `clearModelCache` genuinely clears both layers, and the `SettingsService` wiring is real and hits the right files. All five claimed test results reproduce exactly — with one environment caveat documented below.

**One genuine defect was found:** the provider-ID filename sanitizer is not collision-safe. Two distinct provider IDs can map to the same cache file.

---

## Findings (most severe first)

### 1. Provider-ID sanitization is not injective — distinct provider IDs can collide on one cache file (Medium)

**Where:** `source/services/model-service.ts:62`

```ts
const safeName = provider.replace(/[^a-zA-Z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
```

**What's wrong:** `_` is a pass-through *safe* character while also serving as the escape delimiter, and the hex payload is unpadded. Any provider ID containing a literal `_XX_` sequence (XX = lowercase hex of some character code) sanitizes to exactly the same string as the ID containing that raw character. Verified by execution:

```
"gemini/flash"     -> gemini_2f_flash
"gemini_2f_flash"  -> gemini_2f_flash     COLLISION
"custom:8000"      -> custom_3a_8000
"custom_3a_8000"   -> custom_3a_8000      COLLISION
```

This is reachable through real input, not just adversarial strings: custom provider IDs are produced by `normalizeProviderIdentifier` (`source/services/settings/custom-provider-normalization.ts:11`), which only converts whitespace to `_`. So a custom provider named `gemini 2f flash` gets ID `gemini_2f_flash` and writes the same cache file as a provider named `gemini/flash`.

**Why it matters:** cross-provider cache poisoning. Provider A's fetch writes the file; provider B's `fetchModels` gets an L2 hit and serves A's model list — labeled with A's provider IDs and A's `contextWindow` values — for up to an hour, and persists it to B's in-memory cache. Note `readDiskCache` never checks `parsed.provider === provider` (it validates only version/timestamp/models shape, `model-service.ts:80-102`), so nothing on the read path would catch it. Likelihood is low (needs two contrived names), but the invariant asked of this design — "no two distinct provider IDs can map to the same sanitized filename" — is violated. Built-in provider IDs (openai, openrouter, codex, …) cannot collide with each other.

**Fix direction:** make the encoding unambiguous by also escaping the escape character (e.g. `_` → `__` or `_5f_`, with padded hex for everything escaped). Trivial and backward-compatible enough for a cache (version-bump the file format or accept a one-time re-fetch).

Minor sub-note, same function: a provider ID that is a Windows reserved device name (`nul`, `con`, …) yields `nul.json`, which cannot be created on stock Windows. This degrades gracefully — `writeDiskCache` warns and continues, read is a permanent miss — so it costs only caching for that provider, never correctness.

### 2. Claimed `test:related` run did not reproduce as first executed — root cause is the harness `TMPDIR`, not the change (No defect; reproducibility caveat)

**Where:** my execution environment, not the code.

The author claimed `pnpm test:related ./source/services/model-service.ts` → 108 passed | 1 skipped (109). My first run failed: 3 files / 6 tests failed — all in `source/tools/file/apply-patch.test.ts`, `create-file.test.ts`, `search-replace.test.ts` ("needsApproval requires approval for outside workspace"). None of these import anything the diff touches.

Root cause, verified empirically:

- My shell runs with `TMPDIR=/tmp/qduc/term2-nodejs`.
- `SANDBOX_TEMP_DIR` (`source/utils/shell/temp-dir.ts:24-45`) resolves to `TMPDIR` when it already ends in `term2-nodejs` → `/tmp/qduc/term2-nodejs`.
- The failing tests mock `process.cwd` to `os.tmpdir()` — which is `TMPDIR`-derived — so their "outside workspace" target (`../outside.txt`) lands *inside* `SANDBOX_TEMP_DIR`, which `resolveWorkspacePath` explicitly allows (`source/tools/utils.ts:48-50`). Approval therefore correctly returns `false`, and the assertion `expect(result).toBe(true)` fails.
- Proof: re-running the same three files with `TMPDIR=/tmp` → **114/114 pass**. Running them unsandboxed (without touching TMPDIR) → same 6 failures, confirming it is not my sandbox's write policy.

With `TMPDIR=/tmp`, the full command reproduces the author's numbers exactly (see §Test Results). The failures are an artifact of executing the suite from inside an agent harness whose `TMPDIR` points at the app temp root — not a defect in this diff. Worth knowing if this worktree's commands are ever re-run from inside such a shell.

### 3. The 1-hour TTL bounds only the disk layer; L1 remains unbounded and cross-process invalidation does not exist (Informational; pre-existing semantics)

**Where:** `source/services/model-service.ts:167-170` (L1 hit has no expiry check), `:89-94` (TTL applies only on disk read).

**What's true:** a long-running process (interactive app, gateway) serves model lists from L1 indefinitely until something calls `clearModelCache` in *that* process. A config change made in a *different* process (CLI invocation, second window) removes the disk file, but the already-running process neither notices nor re-checks TTL, because L1 hits never touch the disk.

**Why it's OK to note but not flag as a defect:** this is exactly the pre-existing L1 semantics; the diff adds a bounded layer underneath without changing L1. In-process config changes *are* caught because `SettingsService` clears L1 (see finding 6). Just don't read the report's "1-hour TTL" as a system-wide staleness bound — it is a bound on fresh process starts only.

### 4. An empty model list is cached — including to disk — for a full TTL (Minor)

**Where:** `source/services/model-service.ts:190-197`.

`rawModels.map(...)` is cached and persisted unconditionally; a provider endpoint that returns `[]` without throwing (auth degradation, partial outage behind a proxy) pins an empty list for 1 hour on disk, where previously the empty result lived only in L1 for the process lifetime. All current providers throw on failure paths, so this is observational — but if a provider ever soft-fails to `[]`, the disk layer extends the blast radius from one process to every process started within the hour.

### 5. No fsync of the directory after rename (Informational)

**Where:** `source/services/model-service.ts:143`.

Data is fsync'd before rename (correct ordering), but the directory entry is not fsync'd after rename, so a crash in the window between them can lose the file entirely (content durable, name not). For a cache the worst case is a miss and re-fetch; the mirrored `settings-persistence.ts:351-375` pattern has the same property. No action needed.

### 6. The "concurrent atomic write stress test" is single-process and does not exercise the cross-process race it names (Test-quality note)

**Where:** `source/services/model-service.test.ts:866-903`.

Ten `fetchModels` calls run under `Promise.all` in one Node process; since `writeDiskCache` is fully synchronous, the writes serialize and the test cannot observe a real inter-process race — the scenario the report's §4 design argument is about. The test still has value (repeated write/overwrite integrity), but it doesn't prove the concurrency claim. I verified that claim independently instead: a standalone stress with 4 child processes × 300 `openSync('wx')`+write+fsync+rename cycles on one target while a reader loop `readFileSync`+`JSON.parse`d continuously → **1766 reads, 0 parse failures, 0 leftover temp files, final file valid**. The mechanism holds; only the test's evidentiary weight is overstated.

---

## Verified correct

**Atomic write (point 1) — correct.** `writeDiskCache` (`model-service.ts:110-156`) faithfully mirrors `settings-persistence.ts:351-375`: `mkdirSync(recursive)` → unique same-directory temp name (`.name.pid.timestamp.random.tmp`, same filesystem guaranteed) → `openSync(tempFile, 'wx')` exclusive create (a colliding temp name fails loudly rather than clobbering) → `writeFileSync(fd)` → `fsyncSync(fd)` *before* `closeSync` (correct order) → `renameSync` (atomic on POSIX; `MOVEFILE_REPLACE_EXISTING` on Windows). Failure cleanup is real, not decorative: the `tempCreated` flag is set only after a successful open and cleared only after a successful rename, so every failure path (write, fsync, close, rename) unlinks the temp file and the target is never touched; the unlink itself is best-effort and cannot mask the original error. All write failures are downgraded to a `warn` (`:146`) so `fetchModels` returns the fetched models even when the disk is full or read-only. Readers are TOCTOU-safe (`existsSync` + `readFileSync` inside the same try). Confirmed by the cross-process stress in finding 6.

**TTL / clock skew (point 3) — cannot serve stale disk data.** `readDiskCache` (`model-service.ts:80-94`) rejects: non-object JSON, `version !== 1` (strict, so `"1"` is a miss), non-finite `timestamp` (NaN covered), `age < 0` (a timestamp in the future — reader clock behind writer clock — is a miss, never served), and `age >= ttlMs` (boundary expires at exactly 1 hour, matching the report). A reader with a fast clock only shortens effective freshness. Injected `now`/`ttlMs` are honored on the read path. The only stale-serving channel is L1 (finding 3), which is pre-existing.

**Corruption tolerance (claimed) — confirmed.** ENOENT, invalid JSON, schema mismatch, and invalid elements (null / missing `id`) all return a miss without throwing (`:73-107`); the next fetch overwrites the bad file atomically. Each mode has a dedicated test (`model-service.test.ts:685-801`), and the read failure logs at debug rather than warn, which is the right level.

**`clearModelCache` clears both layers (point 4) — confirmed.** `model-service.ts:222-257`: provider-scoped call deletes the L1 key *and* the sanitized disk file; the full call clears the whole map *and* removes every `.json` and `.tmp` in the models dir (the `.tmp` sweep also cleans crash orphans; racing it against another process's in-flight write costs that process one failed rename, logged and harmless). Disk clearing is wrapped so it can never throw.

**`SettingsService` triggers it correctly (point 4) — confirmed by tracing every call site.** `invalidateChangedProviderModelCaches` (`settings-service.ts:455-481`) diffs previous vs. next provider lists via `resolveProviderId` + `providerConfigsEqual`, and calls `clearModelCache(id)` for exactly the added/removed/changed IDs. It is invoked at all four provider-update boundaries: `setPersistentDynamic` (`:815`, before broadcast/save), `setPersistentDynamicTransaction` (`:873`, after a durable save), `reset('providers')` (`:923`), and reset-all (`:932`). The picker refresh path also clears disk: `ModelCatalogSession.invalidate` → `clearModelCache(provider)` (`model-catalog-session.ts:78`). Critically, every production fetch path uses the *default* cache dir — `use-model-selection.ts:22`, `use-mentor-pool-selection.ts:184`, `gateway.ts:345`, `agent-client.ts:1050`, `agent-chat-service.ts:137/230` pass no `cacheDir` — so the invalidation (which resolves the default dir) always deletes the file production writes. (`AgentChatService.clearModelCache` at `agent-chat-service.ts:43` is an unrelated chat-turn cache; it is not part of this path.) The known residual gap — out-of-band edits to settings.json while no term2 process runs, bounded by the 1-hour TTL — is honestly disclosed in the report's §6.

---

## Test results (re-run by reviewer, not taken from the report)

| # | Command | Author claimed | Reviewer measured | Match |
|---|---------|----------------|-------------------|-------|
| 1 | `pnpm test source/services/model-service.test.ts source/services/models/model-catalog-session.test.ts source/services/models/model-listing.test.ts` | 3 files, 43 passed | 3 files passed, **43 passed** (3.81s) | ✅ |
| 2 | `pnpm typecheck` | exit 0 | exit 0 (`tsc --noEmit`) | ✅ |
| 3 | `pnpm test:related ./source/services/model-service.ts` | 108 passed \| 1 skipped (109); 1895 passed \| 2 expected fail \| 2 skipped | First run: **3 files / 6 tests failed** (finding 2, harness `TMPDIR` artifact). With `TMPDIR=/tmp`: **108 passed \| 1 skipped (109); 1895 passed \| 2 expected fail \| 2 skipped** (50.3s) | ✅ after env fix |
| 4 | `pnpm test:related ./source/services/models/model-catalog-session.ts ./source/services/models/model-listing.ts` | 21 files; 240 passed \| 1 skipped | **21 files passed; 240 passed \| 1 skipped** (13.4s) | ✅ |
| 5 | `pnpm exec vitest run --config vitest.provider-black-box.config.ts scripts/provider-black-box/provider-contract.test.ts` | 1 file, 26 passed | **1 file passed, 26 passed** (1.21s; run with `NODE_ENV=test` per repo policy for direct vitest invocations) | ✅ |

Additional evidence gathered: sanitizer collision demo (finding 1) and 4-process write/rename vs. reader stress (finding 6), both one-off scripts outside the repo.

---

## Bottom line

Ship-worthy with one fix: make the filename sanitizer injective (escape `_`). Everything else the report claims about atomicity, corruption tolerance, TTL semantics, cache clearing, and settings invalidation is accurate as implemented, and every claimed test number is genuine. The two blemishes beyond the sanitizer are documentation-level: the concurrency test proves less than its name suggests, and the "1-hour TTL" should not be read as bounding long-lived processes' in-memory caches.
