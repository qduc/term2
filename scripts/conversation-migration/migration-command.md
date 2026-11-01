# Standalone offline migration command

`scripts/migrate-conversations.mjs` is a standalone Node entry point, **not** the
product CLI. It imports no app, settings resolver, provider or runtime legacy
fallback. Build the compiled native dependencies using `node rewrite/scripts/build.mjs`.
The production converter is loaded lazily from `./v3-to-native.mjs`; absence or
rejection produces `CONVERSION_FAILED`, never an invented production conversion.
Command-only synthetic controls do not establish converter fidelity or
whole-importer acceptance; verify the real converter through persisted source,
native replay and the resumed provider boundary as separate checks.

## Explicit authority

All three flags are mandatory, unique, and take one path value:

- `--source-copy`: an existing **quiescent copy** of a v3 conversations directory.
  This is an operator assertion, not automatic detection of a live store.
- `--destination`: an existing native conversations directory.
- `--provenance`: the private map file, in a **dedicated directory outside both
  namespaces**. Missing parent directories are created with mode 0700. An existing
  immediate parent must be owned by the current user with mode exactly 0700.

There are no path defaults, positional arguments, environment settings or live
store discovery. Filesystem roots, symlink path components, directory inode aliases,
and overlapping source/native/private-directory trees are refused before migration.
The native namespace is owned by the native helper; bookkeeping and scratch files
never enter it. The operator must retain the provenance directory alongside the
native store: losing it loses proof of prior import. Do not put unrelated files
there or remove its permanent `conv_locks` SQLite databases.

Source access is read-only through `readV3Conversation(path)` (see `v3-input.md`).
The command does not create source directories, repair, chmod, move, delete or
rewrite source files, sidecars, or locks. Ordinary lock files, lock directories and
dangling lock symlinks all skip the log. Source directories must stay quiescent and
their ancestors must not be concurrently renamed/replaced; these checks are not
a malicious-concurrent-filesystem snapshot or protection against changes that occur
entirely between observations.

A paired `<basename>.queue.json` is admitted only when it is a valid persisted
queue-v1 record with neither queued items nor an active execution. Queued or
active work refuses that conversation as `QUEUED_WORK_PRESENT`; malformed,
nonregular (including symbolic-link), unreadable, or observably changing sidecars
refuse it as `QUEUE_SIDECAR_INVALID`. Valid empty records (including paused ones)
and absent sidecars permit migration. The command reads but never imports,
rewrites, quarantines, or removes the sidecar. It checks again after conversion
and before writing provenance, so observed owned work cannot be silently stranded
by publication. These observations do not replace the quiescent-copy precondition.

## Module interface and safe reports

`parseMigrationArguments(args)` returns `{ sourceCopy, destination, provenance }`
or throws. `runMigration(options)` returns a promise of `{ counts, codes }`.
Setup/authority/provenance-write failures reject the command; individual input,
conversion, destination and publication failures are counted while healthy logs
continue. The optional second argument `{ convert }` is solely a temporary
synthetic-control seam. The executable exposes no override, hooks or alternate
converter flag. Its normal lane always uses the real sibling converter.

Enumeration sorts immediate directory entries. Every `.jsonl` entry is accounted
as canonical, including nonregular ones which the strict reader rejects. `.deltas`
and `.json` entries are counted separately as paired or orphaned; orphans are never
imported, and paired `.json` is ignored nonauthoritative metadata. `.lock` and other
entries have separate counts. Each canonical finishes as migrated, noop, skipped
or failed. Reader details are deliberately collapsed to `INPUT_FAILED`; neither
paths nor individual log identifiers are part of reports.

Fixed per-log codes are `SOURCE_LOCKED`, `INPUT_FAILED`, `UNSUPPORTED_ID`,
`QUEUED_WORK_PRESENT`, `QUEUE_SIDECAR_INVALID`, `SOURCE_CHANGED`, `FOREIGN_TARGET`, `TARGET_REFUSED`, `TARGET_MISSING`,
`CONVERSION_FAILED`, `PUBLICATION_FAILED`, `ALREADY_MIGRATED`, and `MIGRATED`.
The executable prints exactly one JSON aggregate, exits 0 for all successful/noop,
2 for any failed/skipped log, and 1 with `{ codes: { COMMAND_REFUSED: 1 } }` for
invalid arguments/setup/authority/durability failures. No help/error path prints
raw exceptions. Native lineage discovery's synchronous raw warning is suppressed
inside its bounded read; corruption is reported only via the fixed aggregate code.
Private source data, source paths/IDs and native entries are never returned by this
interface. The provenance **does** contain private paths and exact IDs; do not log it.

## Durable intent, receipt and exact identity mapping

`command-provenance.mjs` stores format `term2-offline-migration-1`, binding canonical
source and destination directory paths. `records[oldUuid]` contains the exact
`conv_<sameUuid>` ID, canonical SHA-256, present-deltas SHA-256 (or null), native
initial-prefix byte length/SHA-256, accepted final sequence, and `pending` or
`complete`. Only lowercase, exact UUID spellings are supported; no fallback names,
case normalization, random ID mapping or source-derived path traversal is allowed.
The ignored `.json` and an accepted empty queue sidecar are deliberately not authority hashes.

The per-private-directory `acquireDirectWriterLock` on `command-authority` serializes
cooperating processes with process-death recovery. It is outside native/source
namespaces. Existing maps must be regular, singly linked, current-user-owned 0600
files with matching format/directory binding and structurally valid receipts.
Foreign/malformed maps are refused, not reset. Map replacements use an exclusive
0600 temporary file, full file fsync, atomic rename and parent-directory fsync.
Private-directory ancestry is fsynced before publication, including newly created
parents. Kill-left temporary/scratch files are harmless outside both namespaces;
normal operation removes its own scratch. No automatic stale-lock deletion exists.

For each newly admitted log:

1. Strict-read/replay the source, refuse invalid or owned paired queue state, and
   compute its canonical/delta identity. Reject
   an existing native root with no receipt, even if it might coincidentally match.
2. Convert, then call the **real** `importDirectSession` into a unique private
   scratch namespace. This obtains deterministic native bytes/hash and accepted
   sequence using the real encoder, hydration and replay; there is no second encoder.
3. Recheck the queue sidecar, then save and fsync a pending receipt **before** publication. If replacing an existing
   pending intent with no target, regenerated native hash/length/sequence must match.
4. Strict-read/replay the source again immediately before calling native publication;
   any lock, corruption or changed authority hash refuses publication. A changed copy
   cannot silently overwrite the previous intent or output on a later run.
5. Publish through `importDirectSession` under its native Session writer lock with
   exclusive hardlink creation. Never truncate/replace/adopt differing foreign output.
   The returned encoded length/hash must match the durable intent before completion.
6. Atomically save/fsync the complete receipt. Failure here may leave complete output
   and pending proof; it is not permission to delete or republish the output.

On restart, **both pending and complete** receipts first validate the actual native
lineage using `readDirectLogLineage` under the native root writer lock. The logical
root and accepted root segment must still cover the recorded sequence, and exactly
the recorded number of original root bytes must hash to the receipt. Valid appended
facts and valid physical rotations are allowed; the whole continued file is never
compared with the original import. The native reader validates continuation/ref
hydration and rotation ancestry, including rejection of divergent/broken lineages;
its normal torn-tail acceptance semantics are retained. This read does not replay,
repair or finalize later running work. Before acknowledging a receipt, the root file
and native directory are fsynced, and the source is revalidated again.

A matching pending output (including valid continuation/rotation since publication)
is completed and counted as noop without invoking the converter. A pending absent
root may be regenerated/published only from the unchanged source with matching
encoded receipt. A complete absent root is `TARGET_MISSING`, not recreated. Changed
prefix, corrupt lineage, foreign/differing outputs, or changed source fail closed.
No source cleanup or post-soak move is included.

## Design friction and limits

The native publisher intentionally recognizes **only exact initial-file idempotence**;
using it directly on every rerun would reject lawful native continuation/rotation.
The command therefore owns a durable prefix receipt and uses the existing native
lineage reader, rather than weakening the publisher or inventing a new fact/ref kind.
It pre-encodes once in private scratch and encodes again for real publication because
the current publisher exposes no prepare/commit token. This bounded duplicate CPU/I/O
cost keeps the existing native atomicity boundary unchanged.

The lineage reader currently warns with raw filenames for unrelated corrupt logs.
The command's synchronous warning suppression is confined to receipt validation;
an eventual aggregate-safe native diagnostic callback would remove that friction,
but is deliberately outside this change. Source mutation after final revalidation
cannot be excluded without a filesystem snapshot: use only quiescent copies.
The existing lineage API also rescans the native namespace on each receipt check;
large-store rerun cost has not been measured or optimized in this bounded command.
The provenance is local crash-recovery evidence, not a cryptographically authenticated
receipt against an adversary who can edit both private bookkeeping and native files.
Power-loss behavior follows fsync/atomic-rename/hardlink guarantees of the local
filesystem; synthetic SIGKILL evidence does not emulate storage hardware failure.
