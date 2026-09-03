# Model Listing 1-Hour Disk Cache Implementation Report

**Worktree:** `/home/qduc/term2/.worktrees/model-disk-cache`  
**Branch:** `model-disk-cache`  
**Initial Implementation Commit:** `64b1d284`  
**Report Commit:** `2bdee3c6`  

---

## 1. Summary

A persistent 1-hour disk cache was added underneath the existing module-level in-memory cache in `source/services/model-service.ts:fetchModels()`.

### Problem Solved
Previously, CLI commands such as `term2 --list-models` and `term2 --model <model>` executed as short-lived, standalone Node processes. Because the in-memory cache (`Map<string, ModelInfo[]>`) did not survive process termination, every invocation re-fetched model listings over the network from each provider's API.

### Solution
- **In-Memory Cache (L1):** Retained as the primary, instantaneous cache layer. When warm within a session or process, in-memory cache hits immediately without any filesystem I/O.
- **Disk Cache (L2):** Sits directly underneath L1. When a process starts with an empty in-memory cache, `fetchModels()` reads from `<cacheDir>/models/<safeProviderId>.json`. If valid and written within the 1-hour TTL, results are returned immediately and populate L1 without making API calls.
- **Network Fetch (L3):** Triggered only on L1 + L2 cache miss, TTL expiry (> 1 hour), or cache invalidation. Results are stored in L1 and atomically written to L2 disk cache.
- **Unified Cache Clearing:** `clearModelCache(provider?)` clears both L1 in-memory entries and L2 disk cache files (for a specific provider or across all providers), ensuring interactive picker refreshes (`/model`) and `SettingsService` custom provider changes force fresh network fetches.

---

## 2. Files Changed

1. **`source/services/model-service.ts`**
   - Added `DiskModelCacheEntry`, `MODEL_CACHE_TTL_MS` (1 hour = 3,600,000 ms), and `FetchModelsDeps`.
   - Added `getModelCacheDir(customDir?)` resolving to `<baseDir>/models` where `<baseDir>` is `customDir || testCacheDir || process.env.TERM2_CACHE_DIR || envPaths('term2').cache`.
   - Added `getModelCacheFilePath(provider, customDir?)` with **injective sanitization**: unescaped pass-through characters are strictly `[a-zA-Z0-9-]`. Every other character—including `_` itself—is escaped to `_${hex}_` (e.g. `_` -> `_5f_`, `/` -> `_2f_`).
   - Added `readDiskCache(provider, ...)` validating JSON schema, expiration, model list integrity, and strict provider identity (`parsed.provider === provider`).
   - Added `writeDiskCache(provider, models, ...)` implementing atomic write-temp-then-rename (`.tmp` + `fsyncSync` + `renameSync`).
   - Updated `fetchModels(...)` with 3-tier resolution (L1 in-memory -> L2 disk cache -> L3 network fetch + disk write).
   - Updated `clearModelCache(provider?, opts?)` to remove disk cache files alongside memory cache.
   - Added test isolation hooks: `setModelCacheDirForTest`, `setModelCacheClockForTest`, and `clearModelMemoryCacheForTest`.

2. **`source/services/model-service.test.ts`**
   - Added top-level and suite-level temporary directory isolation so tests never touch `~/.cache/term2`.
   - Added comprehensive test suite for disk cache:
     - Initial fetch writes valid disk cache file with timestamp, version, and models.
     - Second fetch across separate simulated processes (memory cache cleared) serves from disk with 0 network calls.
     - In-memory cache precedence (warm memory cache does not re-read disk).
     - Cache hits within 1-hour TTL (e.g., 59 minutes elapsed).
     - Cache expiration past 1 hour (re-fetches and overwrites disk file).
     - Corrupted JSON tolerance (re-fetches, returns fresh, overwrites corrupt file).
     - Malformed schema tolerance (wrong version, non-array models, invalid timestamps).
     - Invalid model elements tolerance (nulls or objects missing IDs).
     - `clearModelCache(provider)` evicting only target provider on disk and memory.
     - `clearModelCache()` evicting all disk cache files and memory.
     - Concurrent atomic write stress test ensuring racing writes never corrupt cache file.
     - `ModelCatalogSession.invalidate` clearing disk cache.
     - Custom `cacheDir` dependency injection.
     - **Injective Sanitization & Collision Safety:** verifies that provider IDs with raw slashes vs literal escaped sequences (e.g., `'gemini/flash'` -> `gemini_2f_flash.json` and `'gemini_2f_flash'` -> `gemini_5f_2f_5f_flash.json`) map to distinct filenames and isolate cache entries without cross-poisoning.

3. **`source/services/models/model-catalog-session.ts`**
   - Updated constructor dependencies to accept optional `cacheDir`, `now`, `ttlMs`, and `signal`, forwarding them to `fetchModels`.

4. **`source/services/models/model-listing.ts`**
   - Updated `collectProviderModels` and `runListModels` to accept and propagate `cacheDir`, `now`, `ttlMs`, and `signal`.

5. **`source/services/models/model-listing.test.ts`**
   - Added integration test verifying `runListModels` reuses disk cache across separate invocations without making repeated network fetches.

---

## 3. Exact Cache File Location and Format

### Directory Location
- Standard path: `envPaths('term2').cache/models`
  - Linux: `~/.cache/term2/models/`
  - macOS: `~/Library/Caches/term2/models/`
  - Windows: `%LOCALAPPDATA%/term2/Cache/models/`
- Environment override: `process.env.TERM2_CACHE_DIR/models`
- Direct dependency override: `deps.cacheDir/models` or `opts.cacheDir/models`

### File Naming (Injective Encoding)
- File path: `path.join(cacheDir, 'models', `${safeProvider}.json`)`
- Provider ID sanitization: `provider.replace(/[^a-zA-Z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}_`)`
  - Pass-through set: strictly alphanumeric and hyphen `[a-zA-Z0-9-]`.
  - Escape delimiter: `_`.
  - Underscore character code `0x5f` is escaped to `_5f_`.
  - Slash character code `0x2f` is escaped to `_2f_`.
  - Colon character code `0x3a` is escaped to `_3a_`.
  - **No collisions:**
    - `gemini/flash` -> `gemini_2f_flash.json`
    - `gemini_2f_flash` -> `gemini_5f_2f_5f_flash.json`
    - `custom:8000` -> `custom_3a_8000.json`
    - `custom_3a_8000` -> `custom_5f_3a_5f_8000.json`

### JSON Schema & Format (`DiskModelCacheEntry`)
```json
{
  "version": 1,
  "provider": "openrouter",
  "timestamp": 1725370000000,
  "models": [
    {
      "id": "openrouter/model-a",
      "name": "Model A",
      "provider": "openrouter",
      "contextWindow": 128000
    }
  ]
}
```

### TTL
- `MODEL_CACHE_TTL_MS = 60 * 60 * 1000` (1 hour from `timestamp`).
- If `now() - timestamp >= MODEL_CACHE_TTL_MS` or `now() < timestamp` (future clock skew), entry is treated as a miss and overwritten on the next fetch.
- Applies to fresh process starts and on-disk reads.

---

## 4. Concurrency & Atomicity Design

Multiple `term2` processes frequently run concurrently. Writing directly to the target cache file could expose readers to partial writes or corrupted JSON.

We adopted the atomic write pattern used in `source/services/settings/settings-persistence.ts:353-365`:
1. Ensure the directory exists: `fs.mkdirSync(dir, { recursive: true })`.
2. Generate a unique temporary filename in the **same** directory (guaranteeing same filesystem for atomic rename):
   `.${baseName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
3. Open temporary file with exclusive flag `'wx'`: `fs.openSync(tempFile, 'wx')`.
4. Write serialized JSON and flush to disk with `fs.fsyncSync(fd)` before closing the file descriptor.
5. Atomically rename the temp file over the target file: `fs.renameSync(tempFile, targetFile)`.
6. Any error in steps 1-5 triggers clean up of the temporary file in a `finally` block.
7. If disk write fails (e.g., read-only filesystem, disk full), the error is logged as a warning and suppressed—`fetchModels` returns the in-memory models and never crashes.

---

## 5. Corruption & Read Tolerance

The read path handles all failure modes gracefully and never throws:
- File does not exist (`ENOENT`): returns `null` (miss).
- Invalid JSON syntax: caught in `try ... catch`, logged at debug level, returns `null` (miss).
- Schema mismatch (`version !== 1`, `provider !== parsed.provider`, non-numeric `timestamp`, non-array `models`, or elements missing `id`): returns `null` (miss).
- On any miss due to corruption or mismatch, the subsequent provider fetch atomically overwrites the file with a fresh, valid cache file.

---

## 6. Judgment Calls & Tradeoffs

### Cache Key Composition & Custom Provider Configuration
- **Decision:** The cache key is composed of the injectively sanitized provider ID (`provider`), matching the granularity of the existing in-memory cache (`Map<string, ModelInfo[]>`) and the signature of `clearModelCache(provider?)`.
- **Tradeoff Analysis:**
  1. **SettingsService Invalidation:** In term2, custom providers are managed through `SettingsService`. Whenever a provider is added, modified (e.g., base URL or API key change), or removed, `SettingsService.invalidateChangedProviderModelCaches` identifies the affected provider IDs and invokes `clearModelCache(id)`. Because `clearModelCache(id)` now deletes `<cacheDir>/models/<safeId>.json`, any settings change made through term2 immediately invalidates the disk cache for that provider.
  2. **External Out-of-Band Edits:** If a user edits `~/.config/term2/settings.json` in an external editor while term2 is not running, term2's runtime change listener does not execute. With provider ID alone as the key, a newly launched `term2 --list-models` could return models fetched from the old endpoint until the 1-hour TTL expires or until the user triggers a force-refresh (`/model` refresh).
  3. **Alternative Evaluated (Config Hashing in Key):** Embedding a hash of custom provider configuration (e.g. `provider-hash.json`) would require `clearModelCache(provider)` (which only receives `provider?: string` and has no access to `SettingsService`) to perform directory globbing and multi-file prefix deletion. Because term2 already has an active invalidation hook on settings updates and the in-memory cache had this exact same limitation, matching the provider ID key with the 1-hour bounded TTL was chosen as the cleaner, more decoupled, and O(1) architecture.

---

## 7. Test Verification & Commands Run

### 1. Focused Unit & Integration Tests (including injective sanitizer collision test)
Command:
```bash
pnpm test source/services/model-service.test.ts source/services/models/model-catalog-session.test.ts source/services/models/model-listing.test.ts
```
Output:
```
Test Files  3 passed (3)
     Tests  44 passed (44)
  Duration  1.76s
```

### 2. TypeScript Typecheck
Command:
```bash
pnpm typecheck
```
Output:
```
$ tsc --noEmit
Done in 460ms using pnpm v11.7.0 (exit code 0)
```

### 3. Statically Related Tests
Command:
```bash
pnpm test:related ./source/services/model-service.ts
```
Output (with standard `TMPDIR=/tmp`):
```
Test Files  108 passed | 1 skipped (109)
     Tests  1895 passed | 2 expected fail | 2 skipped (1899)
  Duration  49.63s (exit code 0)
```

Command:
```bash
pnpm test:related ./source/services/models/model-catalog-session.ts ./source/services/models/model-listing.ts
```
Output:
```
Test Files  21 passed (21)
     Tests  240 passed | 1 skipped (241)
  Duration  16.56s (exit code 0)
```

### 4. Diff-Affected Test Suite
Command:
```bash
pnpm test:changed
```
Output:
```
Test Files  108 passed | 1 skipped (109)
     Tests  1895 passed | 2 expected fail | 2 skipped (1899)
  Duration  88.16s (exit code 0)
```

### 5. Provider Black-Box Contract Suite
Command:
```bash
pnpm exec vitest run --config vitest.provider-black-box.config.ts scripts/provider-black-box/provider-contract.test.ts
```
Output:
```
Test Files  1 passed (1)
     Tests  26 passed (26)
  Duration  2.11s (exit code 0)
```
