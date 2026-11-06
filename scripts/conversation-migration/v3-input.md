# Standalone v3 input boundary

`readV3Conversation(path)` in `v3-input.mjs` is synchronous and read-only. Build
dependencies with `node scripts/build.mjs` before importing it. It imports
compiled legacy decoder/replay modules and the adopted Session fact validator,
not a TS runner. The validator module shares imports with the adopted legacy
store, but this reader never calls its persistence loaders or store constructors.
It has no CLI, provider, network, discovery, output-writing, or repair responsibility.

## Result

- `{ status: 'imported-input', envelopes, restoredState, source }`: `envelopes`
  are validated v3 logical records, atomically expanded, stably merged by `seq`
  (canonical before deltas on ties), then identity-resolved without deduplication.
  `restoredState` is authoritative `replayEvents(..., { finalization: 'reopened' })`
  output, including undo/retry/interrupted-turn semantics. Consumers must not
  reconstruct replay or invent output facts here. All envelope timestamps survive.
- `{ status: 'skipped-locked' }`: a paired lock is live or its ownership cannot
  be proved stale. A stable regular lock of at most 4 KiB is read without following
  symlinks. Only a valid same-host positive PID for which signal 0 returns ESRCH
  is stale; foreign-host, live, malformed, nonregular and uncertain locks still
  refuse the input. The reader never removes or changes a source lock.
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

## Strict persisted structures

`v3-input-validation.mjs` supplements the legacy decoder; it does not change
runtime loading or replay. The persisted `Item` union in
`src/shared/contracts/conversation-items.ts` is closed: assistant turns and durable
journal items accept only reasoning, assistant text, tool calls, tool results and
explicit provider-opaque items, with their required fields. An unknown normalized
item type is corruption, not a new provider extension. A provider-opaque item
requires a string provider and an object item; its inner keys and additive provider
metadata survive verbatim, even when they resemble unknown normalized variants.

Snapshots on undo, accepted input, retry, rewind, assistant turns and compaction
validate `StateSnapshot` and `SavedToolExecution` in
`src/session/logging/conversation-log-events.ts` and
`src/session/tool-execution-ledger.ts`: provider history is an array of objects,
response identity is string-or-null, and every ledger entry has its required
identities, status and start timestamp. `ProviderInputItem` in
`src/shared/contracts/provider-input.ts` is deliberately open: unknown provider wire
types, roles, content and extra fields are lawful. Only its application-owned
metadata shapes (`providerOpaque`, `providerData`, `contextSummary` and personal
memory context) are checked. Ledger `arguments`, `output` and `historyItems`
elements retain their declared unknown payload types.

Saved user and command messages on their corresponding events must match their
required message fields, not merely have an ID and sender. The supplement also
rejects missing personal-memory fields, invalid undo counts (not positive safe
integers), missing required settings/tool payloads, incomplete observation facts
and other owned event structures the decoder checks only partially. The decoder
remains responsible for its existing settings, reference, usage/cost and event
checks; replay still decides lifecycle validity. These checks apply to committed
batch members through the same validation path as ordinary events. They neither
strip additive fields nor inspect uncommitted batch members.

### Failure lesson

The original reader equated successful legacy decoding and replay with strict
integrity. That was false: the recovery decoder intentionally accepts unknown
normalized items, incomplete ledger objects and some unchecked known facts;
replay can silently drop items or normalize an invalid undo count. The standalone
importer therefore owns the stricter persisted-structure assertion before replay.
Verify both refusal of malformed committed ordinary/batched records and exact
preservation of lawful opaque/provider metadata; rejecting unknown provider inner
keys would fix the symptom by breaking the explicit compatibility lane.

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

## Adopted Session adjuncts

The v3 boundary also admits the adopted Session's binding, admission, turn,
interaction, interruption, closure and network facts. The ordinary legacy
`LogEvent` union does not declare these, although `replayEvents` uses them for
accepted-input references, compaction eligibility and interrupted subagents.
`validateSessionFact` checks their version and required fields on a clone; the
original decoded event is retained without interaction sanitization. Unknown
adjunct kinds still fail. Settings baseline validation remains with the legacy
decoder. Admitting a schema-valid adjunct does not invent lifecycle validity: the
existing replay remains responsible for its accepted-input/reference checks.

### Compatibility failure lesson

A closed allowlist copied only from `LogEvent` rejected lawful
`session_turn_started`, making a valid `user_input_accepted` impossible to replay.
The earlier reader controls checked malformed accepted snapshots but had no
positive fixture with its required turn binding. The reader must treat the
adopted Session adjunct schema as a second v3 authority, not classify all facts
outside `LogEvent` as corrupt. Reuse its validator rather than duplicating those
field rules, and exercise both lawful ordinary/batched lifecycle records and
missing required fields. Source DTO equality is checked independently of the
validator's sanitized clone.
