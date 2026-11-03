# Native derived catalogue and search

`withNativeCatalogue(directory, operation)` owns file discovery, cache refresh and
SQLite lifetime for one synchronous operation. Its `list(scope)` returns metadata
ordered by accepted timestamp then logical ID; `search(scope, query, kind?, limit?)`
returns total matched document identities and bounded snippets. The directory must
be the strict native conversations namespace. No source store, provenance map or
migration reader participates. `nativeTranscript(lineage)` is the shared ephemeral
document projection used for indexing and snippet reconstruction.

## Authority and lifetime

`createNativeSearchTool` binds one app-authorized directory, workspace and optional
client binding. The model supplies only query, kind and result count. Both catalogue
operations filter exact target, normalized root and binding. Unbound local queries
exclude bound sessions. CLI SSH discovery binds the resolved endpoint identity.
Runtime search is local-only and requires the client's `sessionBrowser` surface,
matching source positional-versus-interactive availability. Positional/headless CLI
runs and SSH runtimes do not receive this local-file capability. A profile's
`sessions` slot alone does not establish that a client owns a browser. Session
registers the optional Tool only when `nativeToolSlots.sessions` permits it; search
precedes the native rollover tool, matching source session-tool ordering. Configured
generations retain the client-bound capability but reapply their new profile's slot
gate. The native schema promises search only, not the unsupported source
browser/open/read operations.

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
