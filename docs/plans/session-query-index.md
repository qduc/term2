# SQLite index for session tools

## Resume here

Implement a rebuildable SQLite query index for `session_list`, `session_search`,
and `session_read`. Keep canonical conversation logs and delta sidecars authoritative
for persistence, resume, and recovery. The database is a derived representation of
the existing browser projection, not a replacement event store.

Planning baseline: `637b216534a46086eadb06ed713c99a63b38f302`, inspected 2026-09-05.
This document specified proposed work; M0 and M2a are now implemented, reviewed, and merged (see Landed below). M1–M4 remain proposed.
Begin with M0 measurements and driver compatibility, then implement M1–M4 in order.
M2 first repairs the canonical tail/page contract, then implements indexed reads
against that repaired contract; baseline parity must not freeze the reported defects.
Use an isolated worktree under `.worktrees/` for implementation and preserve unrelated edits.
Record actual merge SHAs and evidence here as milestones land.

Landed:

- **M0 (baseline + driver decision) — merged 2026-09-05 (`eee504b7`; commits `156e9e84`, `3c1def4b`, `d1bec11e`).**
  Driver: `better-sqlite3`, one connection per index worker, canonical-browser fallback on lock/read-only/corrupt/disk-full; Node-20 source build verified on Linux x64 only, and a disposable FTS5-trigram runtime probe is an M1 hard capability gate. Results: [M0 baseline](../research/session-query-index-m0-baseline.md) (100/1,000/10,000 sessions; at 10k the canonical path replays 2.21 GB per operation cycle, short-term search p50 ~286 s, and needs a 6 GB heap) and [driver research](../research/session-query-index-m0-driver-research.md). Machine: term2-dev, Linux x64, Node v24.19.0.
- **M2a (canonical tail/page contract repair) — merged 2026-09-05 (`539aad5a`; commits `569f9e3b`, `d25fd9cc`).**
  Independent review (claude, default model) verdict was changes-required; findings 1/3/5 (UTF-16 per-chunk assertion, executed read-envelope tool test, `omitted` "any reason" wording) were fixed in `d25fd9cc`, finding 2 is a documented test-value note, and finding 4's plan-doc half is this entry. Repaired tail fixture: limit 10 and 20 recover the pre-final-record fact (154/159 chunked pages, no loss, duplication, or reverse ordering); limit 5 correctly excludes it as outside the region. Worker receipts: `~/.agents/runtime/session-query-index/receipts/`.

Read the existing retrieval studies for motivation:
[observed usage](../research/session-retrieval-observed-usage.md) and
[seek/tail experiment](../research/session-retrieval-seek-cell.md).
The current tool schema and browser implement `from: "end"`, but it anchors at the
final projected record, not a multi-record tail. Incorporate the
[tail-read report](../bugs/session-browser-tail-read.md) through the contract repair
below. Its live observations are reported evidence; they were not rerun for this plan.

## Problem and outcome

`browseConversationsForProject` in
`source/services/conversation/conversation-persistence.ts` enumerates canonical logs
and calls `loadConversationForProjectReadOnly` for each. That function reads and
replays the transcript before checking project/SSH scope. `SessionBrowser.list`,
`search`, and initial `read` use this path. Search additionally projects and scans
message text; list projects transcripts to derive summaries.

`SessionBrowser.#snapshotForContinuation` already reuses an unchanged transcript.
However, `read` still computes `revision` by serializing and hashing its full
projection on every page. Do not implement a second pagination cache or claim that
every continuation currently replays all logs.

The intended outcome is that unchanged sessions require no transcript replay during
queries; listing reads metadata, reading fetches requested records, and search uses
indexed candidates. Measure tool executor latency separately from model round trips,
approval, and provider streaming. No measured speedup is established by this plan.

## Scope and ownership

- Preserve public tool parameters, envelope fields, scope rules, ranking, output
  budgets, and registration lanes. The explicit behavior changes are the tail anchor,
  page-local `omitted` accounting, and their tool descriptions specified below.
  Preserve other cursor behavior, including stale/invalid outcomes and UTF-16 offsets.
- Keep browser formatting, reference policy, cursor handles, and result fitting in
  `SessionBrowser`. Give a cohesive session-index module ownership of SQLite schema,
  source reconciliation, transaction consistency, and query access. Callers should
  not sequence raw SQL, freshness checks, and rebuilds themselves.
- Reuse canonical decoder/replay behavior. Share the existing browser projection
  where required; do not create a second event interpreter.
- Keep resume, logging durability, provider behavior, and remote storage out of scope.
  No embeddings, server database, ORM, new search language, or additional tool API.
- Locate the index in application data associated with the canonical conversations
  directory, outside project source trees. Match transcript access restrictions and
  exclude it from source control. Do not log message/query text as performance telemetry.

## Tail and page contract repair

The tail-read report identifies a retrieval gap that an index alone cannot fix.
At the planning baseline, `SessionBrowser.read` starts an end read at the final
projected ordinal regardless of `limit`. A complete final record has no successor
cursor; an oversized final record **can** return a cursor for remaining text chunks.
Thus the report's claim that no cursor is ever returned is too broad. Neither case
supports paging backward to earlier records.

The current `omitted` calculation subtracts the absolute page-end ordinal from the
session total. It measures remaining forward records, despite the tool description
claiming a page-local count. This mismatch also affects forward continuation pages.
The existing tests in `session-browser.test.ts` pin that cumulative behavior and the
final-record anchor; revise them with the contract instead of preserving those values
as the differential oracle.

M2a will make these bounded behavior changes in the canonical browser:

- On an initial `from: "end"` read, start at projected ordinal
  `max(0, total - effectiveLimit)`, using the existing default and clamping rules for
  `limit`. Return records in chronological order. A 290-record transcript with
  `limit: 10` starts at ordinal 280, even when `maxChars` fits only its first chunk.
- Continue forward with the existing opaque cursor when records or text chunks
  remain. Omit `from` on continuation. Return no cursor once the selected tail has
  been consumed; a missing cursor says nothing about records before the tail anchor.
  Keep rejecting `from` together with a cursor. Reverse paging and a separate `tail`
  parameter are deferred; this repair provides last-N access through existing inputs.
- Keep `total` as the whole-session projected count. Define `omitted` as
  `total - items.length`: each record represented on this page counts once, including
  a partial or resumed text chunk. Describe this as records represented on the page,
  replacing the ambiguous "started here" wording. Ten returned tail records out of
  290 give `omitted: 280`; a one-record page gives 289, regardless of its ordinal.
- Update the model-facing tool description and applicable prompt guidance together
  with behavior. Explain that `limit` selects the initial tail region, `maxChars` may
  require continuation, and `nextCursor` exists only while forward content remains.

Apply the same repaired contract to indexed reads and canonical fallback. Retain
source-order projection and original message indexes even when projected ordinals
have gaps in their corresponding original indexes.

Other feedback from the report remains explicitly bounded:

- Search hit `updatedAt` is session-level in the current browser. Preserve that
  meaning and clarify it in the search description; per-message time filtering is
  outside this index's API and data-model scope.
- The reported missing rollover successor/brief needs separate lifecycle evidence;
  this plan does not establish whether delivery failed. Moreover, the current
  browser's `project` command branch exposes command/output text, not arbitrary
  `toolArgs`, so a brief stored only in arguments may remain absent even after a full
  tail read. Track that diagnosis in the linked report; do not claim this index or
  tail repair fixes brief persistence, projection, or successor delivery.

## Proposed data model

| Table | Purpose and required fields |
| --- | --- |
| Index metadata | Schema and projection versions; canonical source-directory identity |
| Source inventory | Safe filename/session key, canonical and sidecar source version, loaded/unreadable/invalid classification |
| Sessions | ID, normalized project/SSH scope, timestamps, predecessor ID, model/provider, first-user snippet, projected/skipped counts, projection revision |
| Messages | Stable row ID, session ID, projected ordinal, original message index, kind, original text, JS-normalized search text |
| Search index | FTS5 trigram index over normalized message text, linked to message rows |

Use indexes for scoped timestamp ordering, scoped ID resolution, and
`(session_id, projected_ordinal)`. Original message indexes can have gaps because the
projection skips unsupported records; do not substitute them for projected ordinals.
Keep source freshness versions separate from projection revisions so irrelevant
source changes need not invalidate cursors that the existing implementation accepts.

Metadata, message replacement, search entries, and source version commit atomically
per refreshed session. Start by replaying each changed session and replacing its
projection. Incremental byte-offset replay is deferred: undo, sidecar interleaving,
and rewritten logs make it a separate correctness problem.

## Freshness and failure contract

1. Before list/search and initial reference resolution, reconcile directory membership
   and canonical/sidecar versions against the inventory. Replay only new or changed
   sources. Initially accept O(number of files) metadata checks; do not describe this
   as constant-time retrieval. A directory timestamp alone cannot detect appends.
2. Read source versions before and after replay. Publish only a stable projection.
   Specify and test fallback to canonical browser behavior when a source changes
   during reconciliation; do not silently mark old rows current or retry forever.
3. Resolve queries from a coherent database transaction after reconciliation. This
   does not promise a globally atomic snapshot of concurrently changing log files;
   preserve the existing per-source observation semantics. Keep target and `previous`
   dependency checks for continuation reads, and directory checks for reference changes.
4. Detect writes from another process, sidecar-only changes, imports, forks, undo,
   truncation, atomic replacement, deletion, and scope changes. Remove deleted rows
   and their search entries. Preserve existing handling of partial or malformed logs.
5. Preserve `unavailable` accounting through the inventory, including unreadable
   sources whose project cannot be established. Never expose their transcript or
   guessed scope. Reproduce existing ID/filename and browsability validation.
6. On absent/incompatible/corrupt database, rebuild derived state or use the canonical
   browser path. On lock contention, read-only storage, or disk-full errors, retain
   canonical read availability and log a structured fallback reason. Do not modify
   or delete source logs to recover the index.
7. Make schema initialization/rebuild safe across two processes, with transactional
   publication and no stale refresh overwriting a newer projection. Recheck source
   versions inside the serialized publication protocol. Test interruption between
   replay and commit. Never expose a partially populated corpus as a complete result.
8. Keep expensive reconciliation off the interactive event loop. M0 must select and
   prove the connection/worker lifetime and async browser integration. A synchronous
   SQLite binding alone does not eliminate current synchronous replay stalls.

Watchers and writer notifications may later reduce metadata checks, but cannot be
the sole correctness mechanism. Any new lock timeout, retry limit, or work cap needs
the guard-design skill and evidence for its threshold and fallback behavior.

## Search compatibility

Current `termsFor` splits whitespace and applies JavaScript lowercase; `scoreText`
adds exact/prefix/substring scores per term, including repeated terms. Any matching
term admits a record. Live-session results sort last, followed by existing score,
timestamp, session-ID, and original-message-index ordering. Preserve match-centered
snippets, totals before limits, skipped counts, and output fitting.

Use FTS only to produce a complete candidate set; verify and score with the existing
semantics before applying the result limit. Store JS-normalized text so SQLite's
case handling cannot redefine matching. Escape FTS syntax as literal input and bind
SQL parameters. Do not adopt BM25 ranking or apply an early candidate cap.

Trigram queries need special treatment for short terms and Unicode. Union candidates
for all query terms; scan scoped indexed text for terms or character cases for which
candidate completeness has not been proven. Mixed short/long queries must retain
short-term-only matches. Broad queries may still scan much of the scoped text; report
their cost separately instead of promising uniformly sublinear search.

SQLite documents trigram substring support and limitations in its
[FTS5 documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).
Prove candidate completeness with fixtures containing paths, punctuation, quotes,
SQL/FTS metacharacters, non-ASCII case conversion, combining marks, and emoji.

## Milestones and acceptance

### M0 — Baseline and runtime decision

- Capture fixed synthetic corpora and a read-only local-corpus benchmark manifest
  containing sizes/counts and source revision, without committing private transcripts.
- Measure list, selective/broad/short-term search, exact/prefix/previous initial read,
  tail read, and continuation. Separate missing index, existing index after restart,
  warm unchanged state, and one changed session. Record p50/p95, sample count, replay
  count/bytes, metadata checks, peak memory, and event-loop delay on a named machine.
- Include a fixed tail-retrieval fixture with a needed fact before the final record,
  and record recovered content and page count as well as latency. Keep the original
  baseline results labeled with their final-record semantics. After M2a, rerun the
  same corpus/requests on the repaired canonical backend to establish the equivalent
  behavior reference for indexed tail/page comparisons.
- Cover 100, 1,000, and 10,000 sessions with varied transcript sizes; report aggregate
  bytes and projected records so session count is not the only scale variable.
- Select a Node-20-compatible SQLite driver and verify packaged builds on supported
  OS/architectures, FTS5/trigram capability, connection contention, and worker loading.
  `package.json` currently declares Node >=20; built-in `node:sqlite` was introduced
  in Node 22.5.0 and cannot be assumed available on Node 20. Verify exact
  API requirements against [Node SQLite documentation](https://nodejs.org/api/sqlite.html).
  Do not raise the Node floor as an incidental dependency choice.
- Record the driver, connection ownership, async integration, and measured targets
  before M1. Initial performance objectives: >=5x lower warm p95 list/selective-search/
  initial-read latency at 1,000+ sessions; <=10% continuation p95 regression. These
  are proposed acceptance targets, not results; refine once with M0 evidence and
  explain any revision before evaluating implementation.

### M1 — Persistent metadata and reference resolution

- Add schema/inventory/reconciliation, shared projection, and canonical fallback.
- Serve list and exact/prefix/previous resolution from indexed metadata; load only
  the resolved transcript for read. Keep existing short-reference generation rules.
- Cache revision with the existing read snapshot to remove repeated full hashing.
- Acceptance: result parity for list/reference cases; unchanged list and reference
  resolution replay zero logs. An initial read may replay the resolved transcript
  once; unchanged cached continuations do not replay or rehash it. Search may still
  use canonical replay until M3. A changed source refreshes only that source;
  missing/corrupt index and two-process refresh scenarios retain correct results.

### M2 — Repair the read contract, then index message reads

#### M2a — Canonical contract repair

- Implement the tail anchor, page-local counts, and description changes specified
  above in the canonical browser before using it as the indexed-read oracle.
- Acceptance: a 290-record fixture with limits 5, 10, and 20 returns the corresponding
  tail region; constrained budgets page through that region without loss, duplication,
  or reverse ordering. Cover empty/short sessions, skipped records, an oversized
  final record, UTF-16 chunk boundaries, and absence of a cursor at completion.
- Assert `total - omitted === items.length` on initial forward/tail pages, forward
  continuations, and resumed text chunks. Verify serialized tool envelopes and
  descriptions, including the session-level meaning of search timestamps.
- Run the fixed tail-retrieval case against the repaired canonical backend and
  record its commit and results separately from the pre-repair baseline.

#### M2b — Indexed reads

- Populate message rows and serve pages without loading the full transcript. Preserve
  ephemeral cursor handles, stale/invalid distinction, partial text chunks, UTF-16
  offsets, skipped records, and the repaired M2a tail/page contract.
- Retain full message text initially; record the cost of fetching exceptionally large
  single messages. Do not use SQLite character slicing as a replacement for JavaScript
  UTF-16 slicing without a separately proven mapping.
- Acceptance: complete forward and tail page walks match the repaired canonical
  browser exactly; source, scope, predecessor, and revision changes produce the
  existing cursor outcomes.
  Unchanged initial and continuation reads neither replay nor hash the whole session
  per page, including initial reads after restart with an existing current index.

### M3 — Indexed candidate search

- Add trigram candidate lookup, short/unsupported-term fallback, exact scoring, and
  atomic search maintenance alongside message refresh.
- Acceptance: deterministic fixtures and differential corpus queries reproduce match
  membership, order, snippets, counts, and output budgets. Explain query plans and
  measure selective, broad, short, and mixed-term workloads separately. Unchanged
  indexed searches replay zero logs, including scoped-text fallback for short terms.

### M4 — Recovery, performance, and handoff

- Exercise restart, interrupted rebuild, competing refreshers, schema upgrade,
  source deletion/replacement, sidecar changes, and storage failures using disposable
  fixtures. Rebuild must reproduce the canonical browser results.
- Run the fixed M0 corpora and requests and publish before/after measurements,
  initial build cost, database size, fallback frequency, and remaining
  O(files)/O(matches) costs in
  `docs/research/session-query-index-performance.md`.
- For changed tail/page semantics, use the M2a canonical reference to assess index
  performance and parity. Report the original baseline separately; returning one
  final record and returning a multi-record tail are not equivalent workloads.
- Enable the indexed path by default only after compatibility, parity, failure, and
  performance gates pass. Retain a tested canonical fallback and an internal backend
  selection seam for rollback/diagnosis; a new user-facing setting is not required.
- Update this resume section with landed SHAs and remaining work, and add a concise
  link to the repository work-plan index in coordination with any concurrent edits.

## Validation and delivery discipline

Use test-first behavioral coverage at the browser/index boundary. Deterministic unit
tests use injected source/database boundaries; separately labeled integration tests
exercise a real disposable SQLite database and fixture logs. Do not mock SQLite for
transaction, FTS, restart, or multi-process acceptance claims. Compare structured
results, treating cursor handles as opaque and following each backend's own handles.
After M2a, use the repaired canonical backend as the parity oracle; retain explicit
before/after contract cases so differential tests cannot bless the original tail and
count defects merely because both backends reproduce them.

Run focused browser/persistence/index tests during development, related tests after
coherent changes, and TypeScript checking for TypeScript edits. At handoff run the
isolated full suite and build/package checks because this changes architecture and
dependencies. If provider, bridge, run-loop, registry, or non-interactive code changes,
also run the provider black-box gate under its skill. The fixed no-isolate lane is
not a replacement for the full suite. Report baseline failures and empty selections
separately from passed gates.

No implementation tests or performance measurements were executed to produce this
planning document. Future evidence must identify the implementation commit, runtime,
corpus, machine, commands actually run, and outcomes.
