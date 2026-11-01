# Offline native Session publication

`importDirectSession` in `direct-import.ts` accepts an already-converted native
`Fact` stream with canonical ISO UTC `at` strings and an exact lowercase
`conv_<uuid>` destination ID. The first fact must be matching `session_started`;
physical rotation and interior headers are not import inputs. Original timestamps
are retained, not regenerated. No mapper, source reader, CLI or provenance fact is
provided here.

The helper uses `createLog` (including native payload-reference encoding),
`readFactLines` (schema validation and hydration), and `replay` before publication.
Any replay recovery facts reject the stream rather than creating repair debt.
`createLog`'s optional timestamp callback is confined to creation; ordinary callers,
append's interface and reopen/rolling behavior are unchanged.

The destination must be a real directory accepted by `directLogNames`. Publication
holds `acquireDirectWriterLock` for the destination root. A private sibling stage
(directory 0700, file 0600 before facts are written) stays outside the strict log
namespace. The file is fsynced, exclusively hard-linked into place, and the
destination directory is fsynced. Existing deterministic bytes return
`already-present`; different bytes or a rotated target reject. Results contain
`status`, `id`, byte count `bytes`, and `sha256`, not content.

Normal exit removes the helper's stage. A crash may leave a sibling stage but
cannot expose a partially written public log. Existing files are never overwritten
or repaired. An error after the exclusive link (for example directory fsync failure)
may leave the **complete** published file; retrying checks its bytes. Lock metadata
and a newly created destination may remain after failure. Cooperating Session
writers are excluded; this is not protection against a hostile process replacing
directories concurrently. Staging requires a writable parent on the same
filesystem; mount-point destinations that cannot hard-link fail without publishing.

Publication's rotation-collision probe ignores unrelated undecodable/torn first
headers, consistent with R8. Readable links naming the target still reject, even
when the rest of that header is invalid. Existing-target duplicate checks use the
shared strict lineage reader. This does not infer associations from corrupt bytes.
