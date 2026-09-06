# Bug: a degraded provider model list is cached and trusted for a full hour

**Status:** root cause corrected (2026-09-06). The proven trigger was the
test suite writing fake catalogs into the real product cache — fixed suite-wide
by `49ef6f05` (`source/test-helpers/vitest-cache-isolation.ts`, registered in all
three vitest configs). The local-resilience guard proposed under *Suggested fix*
remains **unimplemented**.
**Severity:** medium — no data loss or unsafe action, but it hard-fails model
selection for up to an hour and reports a misleading cause.
**Component:** `source/services/model-service.ts`, `source/services/models/model-resolution.ts`
**Observed:** twice in one coordination session (2026-09-05, ~14:0x and ~14:53 +07),
plus two prior occurrences the same morning recorded in
`.coord/nested-approval/deliver/codex-degrade-2.md`.

## Symptom

`term2 -m gpt-6-astra -p codex` exits with:

    Error: No models match "gpt-6-astra".

The model exists and the account is entitled to it. Deleting
`~/.cache/term2-nodejs/models/codex.json` and re-running succeeds immediately.
Until that file is deleted the failure persists for the rest of the cache TTL.

The message is actively misleading: it names the *model* as the problem when the
real problem is a stale local catalog. Two separate sessions have wasted time
concluding a model was unavailable or a model ID was wrong.

## Root cause

Three independent decisions combine. Each is defensible alone.

### 1. Any successful fetch is cached, however implausible

`fetchModels` (`model-service.ts:161+`) caches whatever the provider returned:

```ts
cache.set(cacheKey, models);
writeDiskCache(provider, models, deps.cacheDir, deps.now, loggingService);
```

There is no plausibility check. **Correction (2026-09-06):** the one-model
body was never from upstream. Every logged real `fetchModels` call returned the
healthy nine-model list. The poisoner was the test suite: `agent-factory.test.ts`
and `openai-agent-client.public-methods.test.ts` register fake single-model
`codex` stubs and drive the real model-service path with no cache isolation,
persisting `[{id: "gpt-5.3-codex"}]` into the user's actual
`~/.cache/term2-nodejs/models/codex.json` (`gateway/model-list.test.ts` did the
same for a test provider). Fixed in `49ef6f05`.

The weakness this decision creates still stands: whatever reaches the cache
write path is persisted uncritically, so any future writer of implausible data
poisons the catalog for the full TTL.

### 2. Cache validation checks shape, never substance

`readDiskCache` (`model-service.ts:66-111`) validates `version`, `provider`,
`timestamp`, TTL, that `models` is an array, and that each entry has a string
`id`. It never considers **how many** models came back or whether the list
shrank dramatically since the last write.

`[]` also survives every one of those checks — and because the caller tests
`if (diskCached)`, an empty array is **truthy** and returns as a cache *hit*
(`model-service.ts:176-180`). An empty catalog therefore poisons for the full TTL just as
effectively as a one-model catalog.

### 3. A degraded success is trusted more than an outright failure

This is the part that turns a bad cache into a hard failure.
`model-resolution.ts:343-360` has an escape hatch — but only for fetch *errors*:

```ts
if (matches.length === 0) {
  if (parsed.provider) {
    const targetGroup = groups.find(/* ... */);
    if (targetGroup?.error) {
      return { status: 'passthrough', modelId: parsed.rawPattern, /* ... */ };
    }
  }
  return { status: 'no_match', error: `Error: No models match "${deps.modelFlag}".` };
}
```

If the catalog fetch **fails**, the requested model passes through and the run
proceeds. If the catalog fetch **succeeds but is wrong**, there is no error on
the group, so the request is rejected outright.

The system is more forgiving of a provider that is plainly broken than of one
that quietly lies. That inversion is the actual defect.

`MODEL_CACHE_TTL_MS` is 1 hour (`model-service.ts:26`), so one unlucky fetch
governs the next hour of every session on the machine.

## Why it recurs and why it is easy to misdiagnose

Prior investigation (`codex-degrade-2.md`, ~240 read-only probes across two
sessions) established that **no client-controlled request property reproduces
it**: client version, `ChatGPT-Account-Id`, token state, concurrency and request
rate all return healthy 200s. That negative result survives the correction.

Its positive hypothesis does not. The "upstream cold path serving a fallback
list" explanation predicted one-model bodies arriving from real fetches; none
ever was. The observed clustering in time is explained just as well by when
test suites ran — and once the suite was isolated (`49ef6f05`), the recurring
hourly degradation stopped being reproducible at all.

## Suggested fix

The prior diagnosis recommended a **last-known-good subset guard** in
`model-service.ts`. Concretely:

1. On write, read the previous cache entry **with the TTL check disabled**. If
   the incoming list is empty, or is a strict subset that has lost models the
   previous list contained, treat the fetch as **degraded**: keep serving the
   previous entry and do not overwrite it. Log at `warn`.
2. Treat `[]` as degraded explicitly — today it is a truthy cache hit and must
   not be one.
3. Make a degraded catalog behave like a failed one at
   `model-resolution.ts:343-360`, so the existing passthrough applies. A wrong
   catalog should not be more fatal than a missing catalog.
4. Change the user-facing message so it names the real suspect and the fix, e.g.
   *"No models match X. The cached catalog for <provider> may be stale — delete
   `~/.cache/term2-nodejs/models/<provider>.json` to refetch."*

(1) and (2) stop the poisoning; (3) and (4) contain the blast radius when it
still happens. (4) alone would have saved real time in at least three sessions
and is nearly free.

**Guard design note:** this adds a guard that can *suppress* a legitimate
catalog change — a model genuinely being retired would look like degradation.
Per the `guard-design` skill this needs a calibrated escape: the guard should
expire (e.g. accept a shrunken list once it has been seen N consecutive times,
or after the previous entry ages past some multiple of the TTL) rather than
pinning a stale catalog forever.

## Reproduction

Reproducible directly (pre-`49ef6f05` tree): running
`source/lib/agent-factory.test.ts` or
`source/lib/openai-agent-client.public-methods.test.ts` wrote the poisoned
`codex.json` byte-identically. The *consequence* remains reproducible on any
tree by hand-writing a stale catalog:

```
# write a one-model catalog with a fresh timestamp, then observe a real model vanish
```

A regression test should drive `fetchModels` with a stubbed provider returning a
healthy list, then a one-model list, then assert the healthy list is still
served; and separately assert `[]` is not treated as a cache hit. Both are unit
tests against the production functions — no network needed.

## Related

- `.coord/nested-approval/deliver/codex-degrade-2.md` — full upstream
  investigation, probe matrix, negative results.
- `.coord/orch/deliver/w9-codex-degrade.md` — the first round.
- `.coord/nested-approval/HANDOFF.md` — recorded under "Open, not queued".
