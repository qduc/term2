# Session query index M0 baseline

## Scope and reproducibility

This is the pre-index canonical-browser baseline required by M0. It measures
tool-executor work only, not model round trips, approval, or provider streaming.
The implementation commit is `156e9e84a1953e657d104dc00ee019890c39d5af`
(`scripts/session-query-index-m0.ts`). Generated corpus data is deliberately
outside the repository and contains deterministic synthetic text only.

Machine: `term2-dev`, Linux x64, Node `v24.19.0` (the Node version used for
this baseline; it is not the supported-runtime decision). Corpus manifest:
`/tmp/session-query-index-m0-100/manifest.json`, SHA-256
`06d105317d9163e97908a8d71106c7db336de1a886efd9ff1d06b9111a553d32`.
Benchmark result: `/tmp/session-query-index-m0-100/benchmark.json`, SHA-256
`71735a06a21a107d1f7a5b357617bd6aad1758dfec17801aaad7d4b76077f034`.

The generator accepts exactly 100, 1,000, or 10,000 requested sessions and
adds one fixed tail fixture. Each session has 2, 6, or 12 user/assistant pairs
to vary transcript size. The measured 100 corpus contains 101 sessions,
4,597,217 aggregate bytes, and 1,327 projected records. It does not log
message or query text as telemetry.

```bash
pnpm exec tsx scripts/session-query-index-m0.ts generate --size 100 --out /tmp/session-query-index-m0-100
pnpm exec tsx scripts/session-query-index-m0.ts benchmark --corpus /tmp/session-query-index-m0-100 --samples 5
```

Both commands exited 0 on the machine above. The generated `benchmark.json`
is the machine-readable corpus manifest and result. Future index conditions
are declared in it but intentionally unrun: `existing_index_after_restart`,
`warm_unchanged`, and `one_changed_session` are deferred until an index exists.

## Missing-index measurements

All figures are milliseconds, five samples. Replay counts/bytes and metadata
checks are totals across the five samples. “Event-loop p95” is the delay of a
`setImmediate` queued immediately before each synchronous browser operation;
it captures the blocking this current implementation causes.

| Operation | p50 | p95 | Event-loop p95 | Replay count / bytes | Metadata checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| list | 54.09 | 80.99 | 83.40 | 505 / 22,986,085 | 5 |
| selective search | 44.74 | 57.68 | 57.72 | 505 / 22,986,085 | 5 |
| broad search | 657.18 | 698.81 | 698.86 | 505 / 22,986,085 | 5 |
| short-term search | 1,151.76 | 1,195.73 | 1,195.78 | 505 / 22,986,085 | 5 |
| exact initial read | 33.46 | 39.05 | 39.09 | 505 / 22,986,085 | 5 |
| prefix initial read | 29.20 | 29.82 | 30.05 | 505 / 22,986,085 | 5 |
| `previous` initial read | 29.15 | 30.87 | 31.16 | 505 / 22,986,085 | 5 |
| tail initial read | 28.00 | 29.15 | 29.47 | 505 / 22,986,085 | 5 |
| continuation | 30.08 | 33.51 | 33.80 | 505 / 22,986,085 | 5 |

Peak RSS ranged from 192,712,704 to 292,802,560 bytes over the operations;
the per-operation peak is retained in `benchmark.json`. The replay results
confirm that, in the missing-index path, every benchmark operation replays all
101 transcript files once per sample. The continuation result includes its
initial page: current continuation snapshot reuse avoids a second replay only
after that first page has populated the snapshot.

## Fixed tail fixture

The fixture has a required fact in the penultimate projected record:
`TAIL_FACT_RECOVERABLE_BEFORE_FINAL_RECORD`; its final record is
`TAIL_FINAL_RECORD_ANCHOR`. Under **pre-repair (final-record anchor)**
semantics, `session_read({ from: "end", limit: 10 })` returned only
`TAIL_FINAL_RECORD_ANCHOR` in one page. The needed fact was not recovered.
Its p50/p95 latency is 28.00/29.15 ms above. This is a behavior baseline, not
an indexed-read oracle; rerun the identical fixture after M2a under the
repaired multi-record tail contract.

## 1,000 and 10,000-session scaling runs

The corrected corpus retains UUID exact/prefix/`previous` fixtures while using
safe non-UUID bulk IDs; this avoids benchmarking the browser's separate
quadratic UUID-short-reference helper. Both runs preserve varied 2/6/12-pair
transcripts and the same fixed pre-repair tail fixture (one page, returns
`TAIL_FINAL_RECORD_ANCHOR`, and does not recover the penultimate fact).

| Corpus | Samples | Aggregate bytes | Projected records | Replay bytes / operation | Peak RSS range |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 requested (1,001 including tail) | 3 | 15,057,229 | 13,327 | 326,952,585 | 687,755,264–1,151,311,872 |
| 10,000 requested (10,001 including tail) | 2 | 152,556,229 | 133,327 | 2,210,778,390 | 2,644,127,744–4,530,810,880 |

All values below are p50/p95 milliseconds (event-loop p95 in parentheses):

| Operation | 1,000 | 10,000 |
| --- | ---: | ---: |
| list | 1,581 / 1,760 (1,763) | 40,456 / 58,704 (58,707) |
| selective search | 1,614 / 1,651 (1,651) | 43,059 / 44,007 (44,007) |
| broad search | 14,101 / 16,323 (16,323) | 170,748 / 181,235 (181,736) |
| short-term search | 28,922 / 31,099 (31,100) | 286,142 / 294,753 (294,757) |
| exact initial read | 1,216 / 1,233 (1,233) | 66,739 / 81,445 (81,446) |
| prefix initial read | 1,189 / 1,223 (1,223) | 42,369 / 43,127 (43,128) |
| `previous` initial read | 988 / 1,021 (1,021) | 8,852 / 8,860 (8,860) |
| tail initial read | 1,289 / 1,328 (1,329) | 37,237 / 37,296 (37,296) |
| continuation | 1,258 / 1,320 (1,320) | 38,064 / 38,834 (38,834) |

Commands (all exited 0):

```bash
pnpm exec tsx scripts/session-query-index-m0.ts generate --size 1000 --out /tmp/session-query-index-m0-1000
pnpm exec tsx scripts/session-query-index-m0.ts benchmark --corpus /tmp/session-query-index-m0-1000 --samples 3
pnpm exec tsx scripts/session-query-index-m0.ts generate --size 10000 --out /tmp/session-query-index-m0-10000
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec tsx scripts/session-query-index-m0.ts benchmark --corpus /tmp/session-query-index-m0-10000 --samples 2
```

The initial 10,000 benchmark exceeded Node's default heap; the successful run
required a 6 GB old-space limit. Its artifacts are
`manifest.json` SHA-256 `6c3a769205c3660c7da763e2867ee328976c7beb3a59362ffdbebc240a8b39dd`
and `benchmark.json` SHA-256 `60c5d268335a8bbb29a0771fa53416d4ea1b698571720a247e567c038db47adf`.
The 1,000 artifacts are respectively
`3aee71f9cfe1f709a6962e67fec9ae0309ae9d9af95895b7aedaf0bb8274d919` and
`f6d4096405f6959d0d797b00ab293fcb575b979f30a01b4e20f3c6ce8ccacbdb`.

These results reinforce, rather than revise, the proposed >=5x warm p95
target: the missing-index baseline is replay- and event-loop-bound at scale.
Future warm results must include worker dispatch and demonstrate the target
without requiring a multi-gigabyte heap; broad and short-term search remain
separate workloads, not evidence that every indexed query will be sublinear.

## SQLite runtime decision

No Node-20-compatible SQLite driver is currently declared in `package.json`
or `pnpm-lock.yaml`. The existing `node:sqlite` imports elsewhere in the tree
do not make it acceptable for this feature: the package declares Node >=20,
while `node:sqlite` was added in Node 22.5.0. M0 therefore selects
`better-sqlite3` (a production dependency to add in M1, not an incidental M0
lockfile change), subject to the verification detail in
[the driver research note](session-query-index-m0-driver-research.md).

Connection ownership: the session-index module owns one database connection
per worker process, configured and initialized inside that worker. The Ink/UI
thread never calls its synchronous API. Browser queries submit reconciliation
and query jobs to a long-lived worker; the worker serializes its own database
work and returns structured values. Separate application processes use SQLite
transactions/busy handling and must retain canonical-browser fallback on lock,
read-only, corruption, or disk-full errors. This meets freshness-contract item
8 by moving replay and SQLite work off the interactive event loop; it does not
promise that a synchronous binding is non-blocking by itself.

The M0 evidence does not justify changing the proposed targets: retain >=5x
lower warm p95 for list/selective-search/initial-read at 1,000+ sessions and
<=10% continuation p95 regression. This 100-session missing-index baseline
does show that broad and short-term queries need separately reported costs and
that worker dispatch must be included in later comparison measurements.

## Verification

`pnpm typecheck` exited 0. No script unit tests were added: the harness is
validated by its deterministic 100-session end-to-end generation and benchmark
run above. The repository-wide test gate is recorded with the completion
receipt.
