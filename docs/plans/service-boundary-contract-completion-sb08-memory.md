# SB-08 persistent memory — local disposition

**Status:** local disposition; not a new formal contract

## Decision

Persistent memory is a cohesive local interface owned by `FileMemoryStore` and
`MemoryCapabilityBuilder`. The evidence below is useful for the service-boundary
audit, but it does not justify creating Contract 10. In particular, this
packet does **not** create a persistent-memory contract file. Settings
durability, migration, and sensitive bytes remain outside this record.

## Storage characterization

The public `FileMemoryStore` boundary is characterized by
`source/services/memory/memory-store.test.ts`:

- **Atomic index replacement:** `writeIndex()` serializes the index and calls
  `writeFileAtomically()`, which writes a uniquely named temporary file beside
  the destination and then renames it into place. This establishes replacement
  atomicity. It is not an `fsync` or power-loss durability guarantee, and this
  record makes no such claim.
- **Backup recovery:** `load()` recovers the backup when the index is missing or
  not valid JSON. The tests `recovers a missing index from the last durable
  backup` and `recovers a corrupted index from the last durable backup` cover
  both public `list()` paths.
- **Memory-id containment:** `validateId()` rejects traversal and other invalid
  IDs before `itemPath()` constructs a path beneath the item root. The test
  `validates IDs and inputs before constructing item paths` exercises this
  through public `create()`.
- **Serial in-process mutations:** the store uses a root-keyed in-process
  mutation queue. The tests `serializes concurrent in-process mutations` and
  `serializes mutations across store instances sharing a directory` verify
  ordering through public `create()` and `list()` calls.
- **Unavailable content is an error/status, not empty content:** public
  `get()` reports missing content as `MemoryStorageError`, while public
  `search()` marks an indexed item unavailable. These are covered by
  `updates partial fields, changes timestamp, and removes broken entries` and
  `marks search results whose full content is unavailable`.
- **Asymmetric failure settlement:** the two SB-08 characterizations use
  isolated `mkdtemp()` roots. A content-path directory makes public `create()`
  fail without leaving an index entry, and a missing content file lets public
  `remove()` resolve `true` while removing its metadata. The tests are green
  behavioral characterizations, not `it.fails` proofs.

A parsed index with structurally invalid metadata currently throws even when a
valid backup exists. The test `rejects corrupted index metadata with invalid
field types` pins that behavior by first creating a valid indexed item and then
replacing the primary index with structurally invalid JSON data. This is an
existing owner decision, not a retained red test: parsed validation failure is
not treated as the missing/unparseable-JSON backup-recovery case.

Cross-process lost updates remain a classified coverage gap. There is no
lockfile or cross-process coordination, and an in-process test cannot prove two
separate processes' behavior. This record does not imply that guarantee.

## Child authority characterization

`source/services/memory/memory-capabilities.test.ts` exercises the public
`MemoryCapabilityBuilder.build()` boundary for both `explorer` and `worker`.
Each returned read set is asserted to be a strict subset of the main subject's
set, and no returned tool is `memory_create`, `memory_update`, or
`memory_delete`. The test checks set membership and cardinality rather than
assuming a tool position or reimplementing the production slice.

The proposed Contract 03 matrix addition is:

> **C3.3: A read-access child subject receives no mutating memory tool.**

This is a proposal only. Contract 03 is unchanged by this packet.

## Scope boundary

This local disposition records storage and child-authority evidence only. It
does not claim ownership of context injection, initial prompt construction, or
other tool authority. It creates no Contract 10 memory file and changes no
production source.
