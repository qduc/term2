# Standalone v3 input boundary

`readV3Conversation(path)` in `v3-input.mjs` is synchronous and read-only. Build
dependencies with `node rewrite/scripts/build.mjs` before importing it. It imports
compiled legacy decoder/replay modules, not the persistence loader or a TS runner.
It has no CLI, provider, network, discovery, output-writing, or repair responsibility.

## Result

- `{ status: 'imported-input', envelopes, restoredState, source }`: `envelopes`
  are validated v3 logical records, atomically expanded, stably merged by `seq`
  (canonical before deltas on ties), then identity-resolved without deduplication.
  `restoredState` is authoritative `replayEvents(..., { finalization: 'reopened' })`
  output, including undo/retry/interrupted-turn semantics. Consumers must not
  reconstruct replay or invent output facts here. All envelope timestamps survive.
- `{ status: 'skipped-locked' }`: a paired `<basename>.lock` exists, regardless of
  its type, contents, age, or ownership. Nothing reads or removes that lock.
- `{ status: 'failed', error: { code, file?, line? } }`: fixed safe classifications,
  file role (`canonical` or `deltas`) and one-based physical line when applicable.
  No raw exception, path, ID, event contents, or source-provided kind is exposed.
  The module prints nothing. Successful results contain private data; callers must
  not log those results wholesale.

`source.canonical` and a present `source.deltas` contain `status: 'read'`,
`byteCount`, SHA-256 hex `sha256` over **all read bytes**, and `tornFinalLine`.
That field is `null` or `{ classification, line, count: 1 }`, distinguishing an
unterminated invalid-JSON tail from an unterminated atomic batch. A valid ordinary
last JSON record needs no newline; a valid batch does. Committed blank lines,
malformed/unknown/truncated events, non-v3 batch members, and malformed committed
sidecar records fail instead of silently degrading. UTF-8 is fatal even in a tail.
Absent deltas have `{ status: 'absent' }`. The paired `.json` is never opened:
`source.json.status` is `absent` or `ignored-nonauthoritative` (even a symlink).

## Ownership and consistency

The selected filename must end in `.jsonl` with a nonempty safe basename, and the
last `session_init.id` must match it. Earlier init records and foreign envelope
`logId`s remain lawful because legacy forks preserve original history and append
a new init; identities without IDs use the basename fallback. Explicit duplicate
event IDs fail rather than silently collapsing facts. Each physical stream must
increase sequence numbers strictly; gaps are legal because canonical and delta
writes historically share a counter. Cross-stream sequence ties retain the
documented legacy stable ordering.

Canonical/delta paths must be regular non-symlink files. Opens are read-only with
`O_NOFOLLOW`; descriptor/path identity, size, mode, mtime and ctime are compared
before/after reading and replay, including absent-sidecar checks. Locks are checked
before reading, after reading, and before admission. This detects observed changes,
not a filesystem snapshot: a lock created and removed entirely between checks or
a mutation after return cannot be excluded. Run migration only on quiescent copies;
the parent owns destination commit, provenance persistence, and any later source
revalidation. This boundary never opens a source for writing, creates directories,
unlinks files, or treats metadata as authoritative.
