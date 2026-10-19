# Memory retrieval replacement comparison — 2026-10-19

**Keep `memory_retrieve` with the current API. Removing it would lose full, scope-correct access to a project record when a global record has the same ID.** This is an intentional documented distinction, reproduced through the current tool definitions and real file stores. It does not establish that this collision is common: the inspected current snapshot has no overlapping global/project IDs.

On ordinary lookups the tools overlap substantially. Search plus get recovered every complete record returned by retrieve in all 69 snapshot queries when each constituent call had its own 12,000-character allowance. The replacement still needs a scope-selectable read before it can preserve the existing capability in all supported states. No product code or tool exposure was changed.

## Matched execution

Ran 78 paired cases through `createMemoryToolDefinitions()` with schema-parsed arguments and `FileMemoryStore` instances, without mocks or provider calls: nine synthetic contract cases and 69 queries against an isolated snapshot of the default local global store and current Term2 project store. The snapshot contained eight global and 53 project records. Queries were eight strings retained from audit cases A084–A091 plus all 61 record IDs; historical query strings were replayed against current data, not reconstructed historical stores. These are deterministic evidence-access probes, not 69 independently judged user tasks.

Each case compares the same stores and query with `limit: 50`:

- Retrieve: one call with a 12,000-character output budget; one additional many-record case uses 40,000.
- Shared-budget composition: search receives `min(12000, floor(B/3))`; ranked available hits are fetched and paged in order from the remaining aggregate serialized-output budget. Execution stops below the public minimum of 512 characters.
- Generous composition: search and each get/page receive B separately; total output may exceed B. This checks capability separately from the chosen aggregate budget.

Equality means matching scope, ID and complete body exactly for each record actually returned by retrieve. It does not establish that either route found all relevant memories, produced a correct final answer or is an optimal budget allocator. Sources were copied before invocation; every copied production file had the same hash at the end of the run. Source paths, file hashes, code hashes, raw outputs and executed arguments are retained locally. Runtime: v24.19.0; checkout HEAD `e8b54a613b1ee3b9346c5cc706aa5b4db2704de2` with file hashes establishing the inspected source.

## Results

| Case | Retrieve | Search plus get | Implication |
|---|---|---|---|
| Ordinary memories in both scopes | Two full records, 587 serialized characters, one call | Same two records, 1,213 characters, three calls | Ordinary full-body access is composable; raw envelopes add overhead. |
| Same ID in both scopes | Both full records, including the project-specific setting | Both search hits are visible, but get returns the global body for both IDs; the project setting is absent, even with generous budgets | Concrete capability loss on removal with the existing API. |
| Missing global body shadows healthy project twin | One healthy project record plus global-unavailable diagnostic | Search identifies a healthy project hit, but get errors on the unavailable global twin | More output budget cannot repair the addressing problem. |
| Unavailable record with a distinct ID | Healthy record and unavailable diagnostic | Search marks the missing body unavailable; get loads the healthy record | This static diagnostic case is composable. |
| Twelve fitting records, shared 12,000-character budget | All twelve, 11,648 characters, one call | Fixed shared-budget strategy fails to complete three; generous strategy returns all in 14,404 characters and thirteen calls | Bulk loading has a practical envelope advantage here; this is not an impossibility result for optimized composition. |
| Oversized record plus small record | Omits the oversized record and returns the small one | Generous composition pages through the complete oversized record and loads the small one, using 20,409 characters and four calls | Get has useful progressive-disclosure capability that retrieve does not provide in this budget. |
| No matches | Empty result | Empty result | Both handle absence; no downstream answer is evaluated. |
| Unicode and larger-budget cases | Valid bounded responses | Matching bodies where budgets permit | UTF-16 envelope accounting and UTF-8 bytes are recorded separately. |

For the 69 current-snapshot queries:

- Generous composition preserved all complete records supplied by retrieve in **69/69** cases; there were no scope misroutes or get errors in this snapshot.
- The fixed shared-budget strategy missed at least one retrieve-returned complete body in **7/69** cases, all among the eight historical query strings. All 61 ID lookups preserved retrieve's returned bodies under both strategies.
- Retrieve produced **232,639 serialized output characters in 69 calls**; generous composition produced **468,504 characters in 214 calls**. These totals include unequal evidence coverage: generous composition often loads additional records that retrieve omits. They are not a measured 2× cost penalty for equal answers.
- The 61 ID lookups produced the same complete returned bodies: retrieve used 144,786 characters and 61 calls; composition used 180,342 characters and 122 calls, approximately 24.6% more raw serialized output.

These are tool execution counts, not model turns or network round trips. `run_code` can perform discovery, fetching and result shaping in one model tool call and suppress intermediate metadata from the final model-visible output. The raw envelope totals therefore do not establish model-token savings. Internal elapsed timings are retained, but single-process run order and filesystem caching prevent a reliable latency comparison. No provider latency, billed cost or model answer quality was measured.

## Why the capability differs

`createMemoryToolDefinitions()` defines `memory_get` with ID, version, cursor and output budget, but no scope selector. Its global-first loop returns the first match; storage errors propagate to the outer safe error wrapper. Repeating get, adding output budget or composing calls in a script does not select the project twin. A cursor is checked against the memory chosen by that same lookup; it is not a scope-selection API.

`memory_retrieve` instead keeps the scope from ranked search and calls `stores[candidate.scope].get(candidate.memory.id)`. It handles unavailable candidates individually, so an unavailable global twin does not hide the healthy project record. Search alone supplies metadata and at most a bounded content excerpt, not a full-body read API. In the same-ID fixture, the project-specific setting lies outside the search response and is observed only in retrieve's project body.

This distinction is documented deliberately in [the progressive-disclosure contract](/home/qduc/term2/docs/plans/memory-progressive-disclosure.md) under “Memory scopes retain their meanings and are not deduplicated.” Implementation owners: `createMemoryToolDefinitions()` in [memory-tools.ts](/home/qduc/term2/source/tools/memory/memory-tools.ts:244), `FileMemoryStore` in [memory-store.ts](/home/qduc/term2/source/services/memory/memory-store.ts:192), and `rankMemorySearchResults()` in [memory-search.ts](/home/qduc/term2/source/services/memory/memory-search.ts:52). Creating records is scoped, so duplicate IDs are reachable through the existing write API; they are not a malformed storage state.

## Decision and bounded next step

**Removal with the current search/get API fails capability parity.** Preserve retrieve now. The nine synthetic cases prove supported reachable behavior, not its frequency or business impact; the current snapshot shows substantial overlap and no observed same-ID collision.

If reducing the inventory remains valuable, the narrow enabling change is optional scope selection on `memory_get`, retaining its existing global-first default. Re-run the twin and unavailable-shadow cases, then compare one scripted composition against retrieve with equal final model-visible budgets, selected evidence and task outcomes. Preserve bounded omission/unavailability accounting if callers depend on that contract. Only after those checks should removal or exposing a composed helper instead be evaluated. This comparison authorizes no API change and implements none.

## Retained local evidence

- [Protocol and strategies](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/protocol.json)
- [Per-case summary](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/summary.json)
- [Complete arguments, outputs, full-body comparisons and internal timings](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/results.json)
- [Snapshot source hashes](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/snapshot-manifest.json)
- [Source code hashes](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/source-code-manifest.json)
- [Executed comparison script](/home/qduc/term2/.cache/memory-retrieve-comparison-20261019/compare.mjs)

Artifacts live in the ignored workspace cache and contain local memory data; they are not portable commit attachments. No transcript commands or memory instructions were executed. Product runtime integration and end-to-end agent behavior remain untested because this comparison invoked the real memory definition boundary directly.
