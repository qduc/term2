# Native derived catalogue

`withNativeCatalogue(directory, indexer, operation, options?)` owns file discovery, cache refresh and
SQLite lifetime for one synchronous operation. Its `list(scope)` returns metadata
ordered by accepted timestamp then logical ID. The directory must be the strict native
conversations namespace. No source store, provenance map or migration reader participates.
The caller supplies an indexer whose `userMessages(state)` counts the user's non-blank messages
(the app's, which needs the protocol layer).

Resume rows (`list`) come from `folds`: the reduced session state, JSON, stored with the byte offset of the log it
covers. A log that only grew is read from that offset and its new facts are reduced onto the stored state; the
state is rewritten once the tail since the stored one passes 1 MiB, and until then the tail is read again (cheaper
than rewriting megabytes). A log that shrank, changed file, has no state, or whose tail cannot be read alone (a payload
reference into earlier lines) is reduced whole. The cache is disposable; an older one (user_version < 2) is emptied
and rebuilt once. `options.skip` leaves named sessions unindexed for this call (the resume list skips open
sessions, which it takes from memory).

`replayNativeLineage(directory, logical)` replays one lineage for the session browser: its metadata, each rollover
part (the state just before the next rotation resets what the session shows, with the physical log it was written
to) and reasoning text by item.
This module lives in `session/` and the app binds it in `app/native-catalogue.ts`.

## Authority and lifetime

The model reaches sessions only through legacy's `session_list`, `session_search` and `session_read` script tools
in `run_code`, with legacy's definitions. `app/native-session-browser.ts` binds one app-authorized directory,
workspace and optional client binding, and runs legacy's `SessionBrowser` (canonical backend) in a worker over
`app/native-session-browser-store.ts`. The store lists the scope with `list(scope)` and turns each lineage into the
saved-message shape legacy pages and scores, one conversation per rollover part named by its log (the id a rollover
briefing gives), each later part naming the one it rolled over from, as legacy saves rolled-over sessions. The live
part is the session's current log. A newest part whose lineage writer lock is held by another process counts as
running elsewhere, so "previous" skips it like legacy. Like legacy (cli.tsx), only an interactive local client gets a
browser: positional/headless runs and SSH runtimes do not. The catalogue keeps no search index; legacy's browser
scores the projected messages itself.

## Disposable storage

`nativeCataloguePath` returns a sibling `<conversations-directory>.catalogue.sqlite`,
never an entry inside the native namespace or the legacy `session-index.db`.
The file is created mode 0600; newly created parent directories use 0700. SQLite
uses an in-memory rollback journal, so it leaves no text-bearing journal beside
the cache. `catalogue` contains workspace/binding, timestamps, model/profile and
visible user-message count. `physical` contains filename, stat fingerprint and logical
owner. `folds` holds each lineage's reduced state. An older cache's search tables are dropped.

Deleting the closed cache rebuilds it from native logs on next use. SQLite
`CORRUPT`/`NOTADB` errors on opening recreate it once; other errors are reported,
not retried. Logs are never repaired or modified by this module. Unreadable lineages
are unavailable until their physical metadata changes or the cache is rebuilt;
healthy siblings remain listable. Strict namespace violations still
fail globally. An explicit writable open still performs strict lineage validation.

## Refresh

New files without a complete first line are not indexed or warned about; they are
rechecked on the next operation. Previously indexed files still invalidate their
logical lineage if their first line becomes incomplete.

Every operation stats physical native files (device, inode, size, nanosecond mtime
and ctime). Only changed/new/deleted physical owners invalidate logical lineages.
Changed rotation headers identify their logical root; strict lineage replay handles
replacement, rotation and missing required segments. A missing cache permits an
initial full rebuild. Warm listing reads no log bodies.
