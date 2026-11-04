# Native derived catalogue and search

`withNativeCatalogue(directory, transcript, operation, options?)` owns file discovery, cache refresh and
SQLite lifetime for one synchronous operation. Its `list(scope)` returns metadata
ordered by accepted timestamp then logical ID; `search(scope, query, kind?, limit?)`
returns total matched document identities and bounded snippets. The directory must
be the strict native conversations namespace. No source store, provenance map or
migration reader participates. The caller supplies an indexer: `transcript(lineage)` (the app's `nativeTranscript`, which needs the protocol
layer) turns a lineage into searchable documents, and `userMessages(state)` counts the user's non-blank messages.

Resume rows (`list`) come from `folds`: the reduced session state, JSON, stored with the byte offset of the log it
covers. A log that only grew is read from that offset and its new facts are reduced onto the stored state; the
state is rewritten once the tail since the stored one passes 1 MiB, and until then the tail is read again (cheaper
than rewriting megabytes). A log that shrank, changed file, has no state, or whose tail cannot be read alone (a payload
reference into earlier lines) is reduced whole. `list` never builds documents. Equal to a full re-index on 12
grown-log cases (list columns and search hits).

Search documents are the full projection and are rebuilt for the sessions in scope whose log moved since they were
built (`docs_seq` against the fold's `seq`), only when a search runs. Document text is stored in the cache, so a
search returns snippets without reading any log; the cache is disposable, and an older one (user_version < 2) is
emptied and rebuilt once. `options.skip` leaves named sessions unindexed for this call (the resume list skips open
sessions, which it takes from memory).
This module lives in `session/` and the app binds it in `app/native-catalogue.ts`.

## Authority and lifetime

The model reaches sessions only through legacy's `session_list`, `session_search` and `session_read` script tools
in `run_code`, with legacy's definitions. `app/native-session-browser.ts` binds one app-authorized directory,
workspace and optional client binding, and runs legacy's `SessionBrowser` (canonical backend) in a worker over
`app/native-session-browser-store.ts`, which lists the scope with `list(scope)` and turns each lineage into the
saved-message shape legacy pages and scores. Like legacy (cli.tsx), only an interactive local client gets a
browser: positional/headless runs and SSH runtimes do not. Catalogue `search` is no longer reached by the model.

## Disposable storage

`nativeCataloguePath` returns a sibling `<conversations-directory>.catalogue.sqlite`,
never an entry inside the native namespace or the legacy `session-index.db`.
The file is created mode 0600; newly created parent directories use 0700. SQLite
uses an in-memory rollback journal, so it leaves no text-bearing journal beside
the cache. FTS5 uses `content=''` and `contentless_delete=1`: tokens/postings are
stored, not full document text. `documents` contains logical ID, projection identity,
accepted sequence and kind only. `catalogue` contains workspace/binding, timestamps,
model/profile and visible user-message count. `physical` contains filename,
stat fingerprint and logical owner. Search text and listing previews are not stored.

Deleting the closed cache rebuilds it from native logs on next use. SQLite
`CORRUPT`/`NOTADB` errors on opening recreate it once; other errors are reported,
not retried. Logs are never repaired or modified by this module. Unreadable lineages
are unavailable until their physical metadata changes or the cache is rebuilt;
healthy siblings remain searchable/listable. Strict namespace violations still
fail globally. An explicit writable open still performs strict lineage validation.

## R9 refresh and projection

New files without a complete first line are not indexed or warned about; they are
rechecked on the next operation. Previously indexed files still invalidate their
logical lineage if their first line becomes incomplete.

Every operation stats physical native files (device, inode, size, nanosecond mtime
and ctime). Only changed/new/deleted physical owners invalidate logical lineages.
Changed rotation headers identify their logical root; strict lineage replay handles
replacement, rotation and missing required segments. A missing cache permits an
initial full rebuild. Warm listing reads no log bodies. Warm search reconstructs
only matched lineages, once per result batch. The existing strict reader also reads
all sibling bytes for header discovery, but parses only those headers; this known
I/O limitation is not a full transcript parse or a format change.

The ephemeral projection uses `reduceDirectFact` and the public `DirectProjection`,
including current message identities, tool input/output, reasoning timeline entries,
public subagent views, approvals and notices. Hidden provider input and hidden
restoration admissions do not become documents. `history_replaced` follows the
native retained-identity/retainTranscript behavior; physical rotation follows the
native current-projection reset, not a second copy of predecessor messages.
Imported observations remain native messages with their actual role; the index
does not interpret `presentation.sourceMessage` as another schema or text source.

Queries quote each whitespace term independently and join them with OR. FTS token
normalization still applies inside each literal term; punctuation is not raw MATCH
syntax. Kinds are exact public content classes. Results default to 20, at most 50,
with at most 500 characters per snippet. `total` counts authorized matched indexed
identities before the result bound; if a log changes/disappears during reconstruction,
fewer snippets can be returned. Snippets replay matched native logs and resolve the
stored projection identity/accepted sequence, never SQLite text or byte offsets.
