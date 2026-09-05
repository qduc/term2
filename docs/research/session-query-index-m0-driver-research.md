# Session query index M0 SQLite driver research

## Decision

Select `better-sqlite3` for M1 as a production dependency, pinned by the
normal lockfile update at implementation time. It supports Node 20, embeds
SQLite with FTS5, and advertises worker-thread support. Its synchronous API is
acceptable only behind the long-lived session-index worker described in the M0
baseline; it must not be called on Ink's event loop.

`node:sqlite` is rejected for this feature even though other source files use
it: [Node documents it as added in v22.5.0](https://nodejs.org/api/sqlite.html),
whereas this package declares Node >=20. Node also documents `DatabaseSync` as
synchronous, so it would not by itself satisfy freshness-contract item 8.

No `better-sqlite3`, `sqlite3`, or libSQL package is in the current
`package.json` or lockfile. M0 therefore made no dependency or Node-floor
change.

## Capability evidence

- The [better-sqlite3 project](https://github.com/WiseLibs/better-sqlite3)
  documents transactions, extensions, and worker-thread support. Its bundled
  SQLite build is the relevant binary; on Linux x64 this M0 environment's
  Node-20 build invocation showed `SQLITE_ENABLE_FTS5` in its compilation
  flags. The build completed after the command-output capture window, so M0
  records that as build evidence, not a complete package matrix.
- The [SQLite FTS5 specification](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
  specifies that the trigram tokenizer supports general substring matching.
  M1 must make a disposable startup probe (`CREATE VIRTUAL TABLE ... USING
  fts5(..., tokenize='trigram')`) a hard capability check and fall back to
  canonical browsing when it fails. That protects packaged binaries and does
  not assume a compile option from a different build.
- Node `v20.20.2` was obtained locally with
  `npx --yes --package=node@20 node --version`. A clean temp install then
  compiled better-sqlite3 against Node 20 headers on Linux x64. This verifies
  that the driver has a source-build path on the local supported floor; it does
  not verify prebuilt delivery for every release target.

## Concurrency, workers, and packaging

Open a connection only inside each process's index worker; do not pass a
connection across a worker boundary. Within one process, serialize all index
jobs through that worker. Across processes, use a short explicit SQLite busy
timeout plus transactional publish/recheck; a busy, read-only, corrupt, or
full-disk outcome must settle through canonical-browser fallback. M4 must
exercise two concurrent process refreshers; M0 has not yet measured it.

The local check covers Linux x64 only. Packaged verification remains required
for every release OS/architecture (at least Linux x64/arm64, macOS x64/arm64,
and Windows x64 if those are supported by release packaging): install/package
the pinned version, create FTS5 trigram, run the two-process contention probe,
and load the worker entry. Native addons need a matching ABI/prebuild or a
working compiler; this is the material packaging risk compared with
`node:sqlite`. Do not mark that matrix verified from this M0 host.

## Exact local commands and limits

```bash
npx --yes --package=node@20 node --version
# v20.20.2, exit 0

# In a disposable /tmp directory:
npx --yes --package=node@20 -c 'node --version && npm init --yes >/dev/null && npm install better-sqlite3@12.10.0 >/dev/null'
```

The latter compiled the addon using Node 20 headers and exposed
`-DSQLITE_ENABLE_FTS5` in the compiler invocation. Its completion output was
lost when the shell runner yielded during compilation, so do not treat it as a
successful FTS/trigram runtime query. The M1 capability probe above is the
required closure.
