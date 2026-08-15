# Contract 08 — Conversation durability and recovery

Status: **draft under review 2026-08-15; focused gate green after VP-decided repairs.** Owners:
`ConversationLogWriter` (`conversation-log-writer.ts`), conversation persistence
and directory resolution (`conversation-persistence.ts`), composer prompt
history (`history-service.ts`), and log decoding and replay recovery
(`conversation-decoder.ts`, `conversation-replay.ts`).

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C8.1 | Canonical conversation logs and delta sidecars maintain a unified, strictly monotonic sequence counter (`seq`) across turn boundaries and session resumes, including resuming numbering from retained canonical/sidecar bytes after an unsettled orderly close. | Reissued sequence numbers after resume; interleaved or duplicated turn replay that corrupts replayed assistant responses. |
| C8.2 | Critical turn, tool, and approval lifecycle markers (`FSYNC_EVENTS`) are synchronously committed to durable storage (`fsyncSync`) before proceeding, latching write failures permanently. | Unsettled tool executions or approval requests disappearing upon abnormal termination, leading to duplicate execution or corrupted resumed state. |
| C8.3 | Persistent file updates (last session index, session forks, and composer history) stage writes through temporary files and atomic rename, requiring distinct staging paths per save invocation. *(Proven: distinct per-save staging for `last.json` and same-directory temp + atomic rename for composer history.)* | Collided or partial writes corrupting conversation logs, index files, or composer history when staging paths are not distinct or writes are not atomic. |
| C8.4 | Active conversations maintain single-writer mutual exclusion via advisory lockfiles (`.lock`) with truthful diagnostic holder attribution. Same-host locks whose PID is demonstrably dead are reclaimed by the writer and reported as `stale`; unparseable payloads are reported as `corrupt` rather than masquerading as live holders. *(Proven: corrupt-lock attribution, stale-lock reporting, and stale-lock reclaim.)* | Concurrent processes corrupting identical conversation logs, or corrupt/stale lockfiles permanently masquerading as active sessions. |
| C8.5 | Streaming deltas are written to a dedicated sidecar (`.deltas`) without fsync, retained across unsettled orderly closes for replay recovery, and unlinked before lock release upon clean turn settlement (`TURN_SETTLING_EVENTS`). | Loss of in-flight turn context upon orderly close, or unbounded disk accumulation of orphaned sidecar files. |
| C8.6 | Corrupt, unreadable, or partial persistence state degrades gracefully without silent destruction of prior data or unhandled application crashes. *(Proven: typed unreadable project-load result and corrupt-history quarantine.)* | Overwriting corrupted prompt history with a blank file; crashing startup resume flows with raw `fs` errors on unreadable logs. |
| C8.7 | Resumed conversations strictly match their originating execution context (project path and SSH host) unless explicitly overridden. | Loading commands and conversation state from one project or remote host into an incompatible local or foreign workspace. |

## 2. Owners

- **Enforcement:**
  - `ConversationLogWriterImpl` (`conversation-log-writer.ts:282-557`): file
    descriptor and lockfile lifecycle (including stale same-host lock reclaim in
    `acquireLock`), shared monotonic sequence allocation,
    fsync event classification (`FSYNC_EVENTS`), sidecar appending, and
    fail-fast failure latching (`#failure`, `#throwIfFailed`).
  - `conversation-persistence.ts` (`:1-641`): directory hierarchy creation,
    legacy log migration, conversation loading (`loadConversation`,
    `loadConversationForProject`, `loadLastConversation`), deletion (including
    synchronous residual `.deltas` removal), atomic forking
    (`forkConversation`), last-session registry (`saveLastConversation`,
    `readLastConversationFile`, `writeLastConversationFile`), orphan sidecar
    garbage collection (`collectOrphanedDeltaSidecars`), and the advisory-lock
    liveness probe (`isPidAlive`, `setPidAlivenessCheckForTest`) used by
    `isConversationLocked`'s held/stale/corrupt diagnostic.
  - `HistoryService` (`history-service.ts:50-165`): user prompt and multimodal turn
    persistence, history size bounding, duplicate deduplication, legacy format
    loading, corrupt-history quarantine before a valid replacement write, and
    same-directory temp + atomic rename saves.
  - `conversation-decoder.ts` / `conversation-replay.ts`: envelope JSON line decoding,
    corruption skipping, and stateless turn/ledger state reconstruction.
- **Recovery:**
  - `readLogTailState` (`conversation-log-writer.ts:121-172`): trailing newline
    repair for torn final lines; backward scan for high-water `seq` counter.
  - `collectOrphanedDeltaSidecars` (`conversation-persistence.ts:218-240`): startup
    garbage collection of abandoned `.deltas` files whose canonical `.jsonl` is gone.
  - `ConversationLogWriterImpl.#initialize` (`conversation-log-writer.ts:315-353`):
    recovers sequence high-water mark across both canonical log and delta sidecar.
  - `readLastConversationFile` (`conversation-persistence.ts:619-641`): upgrade and
    fallback recovery from legacy `{ id, updatedAt }` structures to `{ entries: [...] }`.
  - `decodeLogEnvelope` (`conversation-decoder.ts:147-184`) / `decodeEnvelopeLines`
    (`conversation-persistence.ts:136-153`): per-line error tolerance skipping
    corrupted JSONL entries during replay.

> [!NOTE]
> **Boundary Note on Directory Placement:** `conversation-log-writer.ts` resides in
> `source/services/logging/` but is durable state persistence, not diagnostic telemetry.
> It manages file locks, write-ahead logs, and sequence reconstruction, governed
> by this contract (Contract 08) rather than the diagnostic logging port (Contract 07 / SB-05).

## 3. Execution paths that share the contract

- **Startup CLI Resume:**
  - `cli.tsx:307` (`--resume <id>` -> `loadConversationForProject`; `status: 'unreadable'` prints a diagnostic and exits 1);
  - `cli.tsx:325` (bare `--resume` -> `loadLastConversation`).
- **Session Forking:** `cli.tsx:337` (`--fork` -> `forkConversation`).
- **Startup Sidecar Housekeeping:** `cli.tsx:772` (`collectOrphanedDeltaSidecars`).
- **Turn Lifecycle Persistence:**
  - Turn Start: `ConversationLogWriter.init` (`session_init` event, lock acquisition).
  - User Prompt: `writer.append` (`user_message` -> `fsyncSync` + `#saveLast`).
  - Active Streaming: `writer.append` (`assistant_journal_delta` -> `.deltas` sidecar, no fsync).
  - Critical Markers: `writer.append` (`tool_started`, `tool_result`, `approval_required`,
    `assistant_journal_item`, `assistant_turn`, `undo` -> `fsyncSync` + `#saveLast`).
    *Note: `approval_resolved` is persisted as an event but is not a member of `FSYNC_EVENTS`.*
  - Turn Settlement: `assistant_turn`, `undo`, or `session_cleared` (`TURN_SETTLING_EVENTS`)
    marks turn settled (`#hasUnsettledTurn = false`); `writer.close` drops settled sidecar.
- **Composer History:** `HistoryService` instantiation (`load`) and each `addMessage` / `clear` invocation.
- **Legacy Migration:** `ensureConversationsDir` executed transparently on public persistence APIs.

## 4. Identities and state crossing the boundary

- **Envelope Record:** `LogEnvelope` (`{ v: 3, seq: number, ts: string, event: LogEvent }`)
  (`conversation-log-events.ts:1-25`).
- **Monotonic Sequence (`seq`):** A shared integer counter strictly increasing across both
  canonical `<id>.jsonl` and sidecar `<id>.deltas` files.
- **Lockfile Payload:** `{ pid: number, startedAt: string, host: string }` (`conversation-log-writer.ts:246`).
- **File Descriptors:** `#fd` (canonical append descriptor) and `#deltaFd` (lazy sidecar descriptor).
- **Failure Latch:** `#failure` (unwrapped original error stored on critical write failure) and
  `#writeErrorLogged` (ensuring at most one telemetry error per writer lifetime).
- **Last Session Registry:** `LastConversationFile` (`{ entries: Array<{ id, updatedAt, projectPath?, sshHost? }> }`).
- **Temporary File Tokens:** Process-unique `.${newId}.${uuid}.tmp` for forks,
  `${lp}.${uuid}.tmp` for `last.json`, and `.history.json.${uuid}.tmp` for
  composer history. Corrupt history is preserved as `history.json.corrupt.<ts>`
  before a valid replacement write.

## 5. Settlement semantics

- **Success:**
  - Critical events (`FSYNC_EVENTS`: `user_message`, `assistant_turn`, `undo`, `session_init`,
    `tool_started`, `tool_result`, `approval_required`, `assistant_journal_item`): `writeSync`
    to `#fd` followed immediately by `fsyncSync` and `#saveLast` update.
  - Streaming deltas: `writeSync` to `#deltaFd` without fsync; turn marked unsettled (`#hasUnsettledTurn = true`).
  - Turn settlement: `assistant_turn`, `undo`, and `session_cleared` (`TURN_SETTLING_EVENTS`)
    mark `#hasUnsettledTurn = false`.
  - Session close: `close()` checks `#closed` guard (`conversation-log-writer.ts:503-505`); if closed,
    rethrows any latched failure and returns; otherwise sets `#closed = true`, syncs/closes `#fd`,
    closes `#deltaFd`, unlinks sidecar if turn settled, calls `#saveLast` if no failure, and releases lock.
- **Critical Write / Fsync Failure:**
  - `#recordFailure(err)` latches the original error; immediately rethrows `err` to caller.
  - Subsequent calls to `append()` and `rotate()` call `#throwIfFailed()` and fail fast by rethrowing the latched error.
  - `flush()` calls `#throwIfFailed()` before attempting fsync, does no descriptor/lock cleanup, and latches/rethrows any new fsync failure.
  - `close()` performs cleanup and lock release before rethrowing any primary or cleanup failure.
  - `rotate()` rethrows any prior failure, cleans up old descriptors/sidecars/locks, and if cleanup fails, records failure and aborts without starting the new session.
- **Delta Write Failure:**
  - Delta append errors are logged via `#logWriteFailure` and discarded without throwing; a lost sidecar
    tail degrades a recovered partial turn but can never corrupt a settled one.
- **Lock Collision:**
  - `openSync(lp, 'wx')` encountering `EEXIST` reads the existing lock payload.
  - Corrupt payload: raises a typed `LockConflictError` carrying `{ sessionId, lockPath, lockInfo: null }`.
  - Same-host payload whose PID is demonstrably dead (`isPidAlive` probe): the lock is reclaimed
    (unlinked) and acquisition retries once; a race re-raises `LockConflictError` with the original holder info.
  - Live same-host PID or foreign-host payload: raises `LockConflictError` with `{ sessionId, lockPath, lockInfo }`.
- **Lock Diagnostic:**
  - `isConversationLocked` returns `null` (no lock), `{ status: 'held', pid, startedAt, host }`,
    `{ status: 'stale', pid, startedAt, host }` (same host, PID demonstrably dead), or
    `{ status: 'corrupt' }` (unparseable or shape-invalid payload). Liveness is never probed
    for foreign-host locks; they are reported as held.
- **History Save:**
  - A history file that failed to parse on load is quarantined (renamed to `history.json.corrupt.<ts>`)
    before the first valid write; if the quarantine itself fails, the replacement write is refused.
  - `save()` stages to a same-directory `.history.json.<uuid>.tmp` file and atomically renames it
    over the destination, so a failed or interrupted write never truncates the prior durable file.
- **Deletion:**
  - `deleteConversation` synchronously removes the canonical `.jsonl`, the `.lock`, and the
    residual `.deltas` sidecar. `collectOrphanedDeltaSidecars` remains for sidecars orphaned by a
    crash (canonical gone, delete never ran).
- **Corruption Resilience:**
  - Replay and decoding skip unparseable or schema-invalid JSON lines, reconstructing state from valid envelopes.
  - Missing sidecar (`conversation-persistence.ts:170-172`) or unreadable sidecar (`:174-181`, e.g. `EISDIR` / read error)
    during resume degrades to settled canonical history without failing the load.
- **Context Mismatch:**
  - `loadConversationForProject` returns `{ status: 'project_mismatch', conversation }` when either `projectPath` or `sshHost` mismatches.
  - `loadConversationForProject` returns `{ status: 'unreadable', error }` instead of leaking a raw `fs` exception.
  - `loadConversation` returns `null` (lossy collapse of missing vs. mismatch vs. read failure).
- **Scope Boundary with Provider Semantics:**
  - This persistence contract governs durable local bytes, descriptors, lockfiles, sidecars, and recovery decoding.
  - It does **not** own provider-facing retry classification, stream cancellation, or ambiguous effect reconciliation;
    those semantic responsibilities begin under [Contract 02](./02-provider-input-continuity-and-effect-settlement.md)
    once persisted bytes are reconstructed into replayed state.

## 6. Observability

- **Structured Persistence Failure Event:**
  - Event `conversation_log.write_failed` logged at `error` level with `{ category: 'persistence', sessionId, errorMessage }`
    (`conversation-log-writer.ts:547-556`).
  - **Once-per-writer Cap:** Telemetry is capped at exactly one log emission per writer instance (`#writeErrorLogged`),
    reset only upon writer rotation (`rotate()`).
- **HistoryService Structured Logs:**
  - `load()` failure logs `'Failed to load history'` with `{ error, filePath }` (`history-service.ts:90-94`).
  - `save()` failure logs `'Failed to save history'` with `{ error, filePath, messageCount }` (`history-service.ts:129-135`, quarantine refusal; `:156-161`, write/rename failure).
- **Silent Swallowing Paths:**
  - Legacy migration errors silently ignored (`conversation-persistence.ts:71-73`).
  - `deleteConversation` unlink failures ignored (`:396-421`).
  - `writeLastConversationFile` write errors silently ignored (`:645-662`).
  - Orphan sidecar cleanup failures silently ignored (`:235-237`).
  - `HistoryService.save()` write errors caught and logged without propagating out of `addMessage` (`history-service.ts:156-161`).
  - `append()` calls after writer is closed or before fd initialization silently drop events without disk writes or `saveLast` calls (`conversation-log-writer.ts:357-359`).

## 7. Public boundary under test

- **`ConversationLogWriter`:** Tested via `createConversationLogWriter` using custom directories,
  isolated temporary folders, and injected `WriterFileSystem` (`conversation-log-writer.test.ts`).
  Stale-lock recovery proofs inject the `isPidAlive` option (or reap a real child PID) so PID
  liveness is controlled deterministically and no arbitrary real PID is ever probed.
- **`conversation-persistence`:** Tested via exported functions (`loadConversation`, `loadConversationForProject`,
  `loadLastConversation`, `deleteConversation`, `forkConversation`, `saveLastConversation`,
  `collectOrphanedDeltaSidecars`, `isConversationLocked`, `isPidAlive`) controlled by `setConversationsDirForTest`
  and `setPidAlivenessCheckForTest` (`conversation-persistence.test.ts`). All tests execute sequentially
  (`it.sequential`) due to module-level override state.
- **`HistoryService`:** Tested via public constructor and instance methods (`addMessage`, `getMessages`,
  `getTurns`, `clear`) against isolated temporary paths (`history-service.test.ts`).
- **Stateless Replay:** Tested via `replayEvents` and `decodeLogEnvelope` (`conversation-replay.test.ts`).

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Exact source evidence | Exact test evidence (file:line title) | Status |
| --- | --- | --- | --- |
| **Monotonic Sequence Continuity (orderly-close resume)** | `conversation-log-writer.ts:322-331` | `conversation-log-writer.test.ts:139` `"resumes sequence numbering past a retained sidecar-dominant tail after an unsettled orderly close"` & `:214` `"continues sequence numbers when reopening a log with legacy and malformed trailing records"` | existing tested invariant — orderly-close resume from retained bytes; no crash/power-loss claim |
| **Critical Event Fsync Classification** | `conversation-log-writer.ts:17-29, 380-392, 538-545` | `conversation-log-writer.test.ts:555` `"exact FSYNC_EVENTS classification: only specified critical events trigger fsyncSync and saveLast"` & `:311` `"surfaces a critical fsync failure, latches it, and does not advance last conversation"` | existing tested invariant & new green characterization |
| **Sidecar Settled Lifecycle** | `conversation-log-writer.ts:446-457, 526` | `conversation-log-writer.test.ts:58` `"keeps streaming deltas out of the canonical log and drops the sidecar on a settled close"` & `:94` `"session_cleared settles in-flight turn and removes delta sidecar on close"` | existing tested invariant & new green characterization |
| **Unsettled Close Retention** | `conversation-log-writer.ts:400-413, 446-457` | `conversation-log-writer.test.ts:79` `"retains the sidecar when the session closes with an unsettled turn"` | existing tested invariant |
| **Sidecar Replay Recovery** | `conversation-persistence.ts:174-181` | `conversation-persistence.test.ts:1393` `"delta sidecar: an interrupted turn replays identically to the legacy inline format"` | existing tested invariant |
| **Absent Sidecar Degradation** | `conversation-persistence.ts:170-172` | `conversation-persistence.test.ts:1428` `"delta sidecar: a missing sidecar still loads the settled part of a conversation"` | existing tested invariant |
| **Unreadable Sidecar Degradation** | `conversation-persistence.ts:174-181` | `conversation-persistence.test.ts:1716` `"loadConversation: unreadable sidecar degrades to canonical settled conversation"` | new green characterization |
| **Orphan Sidecar GC** | `conversation-persistence.ts:218-240` | `conversation-persistence.test.ts:1445` `"delta sidecar: GC removes only sidecars whose conversation log is gone"` | existing tested invariant |
| **Atomic Fork Success & Provenance** | `conversation-persistence.ts:501-505` | `conversation-persistence.test.ts:304` `"forkConversation: immediately persists the fork identity, provenance, and source history"` | existing tested invariant |
| **Atomic Fork Failure Publication & Cleanup** | `conversation-persistence.ts:501-513` | `conversation-persistence.test.ts:1736` `"forkConversation: failed publish leaves destination untouched and unlinks temporary staging file"` | new green characterization |
| **Fork Settled-Only Scope** | `conversation-persistence.ts:474-498` | `conversation-persistence.test.ts:1472` `"delta sidecar: forking a session with a live sidecar carries settled turns only"` | existing tested invariant |
| **Lock Conflict Attribution** | `conversation-log-writer.ts:250-301` | `conversation-persistence.test.ts:277` `"lock: collision throws LockConflictError"` & `:297` `"lock: writer init against existing corrupt lockfile still throws LockConflictError"` | existing tested invariant & new green characterization |
| **Lock Release on Close** | `conversation-log-writer.ts:271-280, 530` | `conversation-persistence.test.ts:287` `"lock: released on writer close, second writer succeeds"` | existing tested invariant |
| **Context Mismatch Detection (Project & SSH)**| `conversation-persistence.ts:284-286` | `conversation-persistence.test.ts:428` `"loadConversationForProject: reports project mismatch"` & `:1783` `"loadConversationForProject: isolates sessions by sshHost when matching or differing from expected host"` | existing tested invariant & new green characterization |
| **Corrupt Record Line Skipping** | `conversation-decoder.ts:147-184`, `conversation-persistence.ts:136-153` | `conversation-persistence.test.ts:148` `"loadConversation: skips malformed known event lines and continues replay"` | existing tested invariant |
| **Torn Final Line Repair** | `conversation-log-writer.ts:121-172` | `conversation-log-writer.test.ts:214` `"continues sequence numbers when reopening a log with legacy and malformed trailing records"` | existing tested invariant |
| **Legacy Migration Scope** | `conversation-persistence.ts:47-74` | `conversation-persistence.test.ts:1233` `"ensureConversationsDir: automatically migrates files from log to data directory"` & `:1605` `"ensureConversationsDir: migration moves only .jsonl and last.json and does not migrate .lock or .deltas"` | existing tested invariant & new green characterization |
| **Post-Close Append Drop** | `conversation-log-writer.ts:355-359` | `conversation-log-writer.test.ts:504` `"append after close silently drops events, writes nothing to disk, and does not invoke saveLast"` | new green characterization (explicit owner policy / gap) |
| **Writer Close Idempotency** | `conversation-log-writer.ts:502-536` | `conversation-log-writer.test.ts:533` `"successful writer close is idempotent and triggers no redundant saveLast or mutations on second close"` | new green characterization |
| **Writer Structured Telemetry Once** | `conversation-log-writer.ts:547-556` | `conversation-log-writer.test.ts:617` `"emits structured conversation_log.write_failed once with category persistence and sessionId on critical write error"` | new green characterization |
| **History Size Bounding & Clear** | `history-service.ts:137-142, 161-164` | `history-service.test.ts:92` `"trims history to maxHistorySize keeping newest entries"` & `:110` `"clear() empties in-memory turns and persists empty history"` | new green characterization |
| **History Error Observability** | `history-service.ts:90-94, 156-161` | `history-service.test.ts:128` `"load() logs Failed to load history with filePath when history file is corrupt"` & `:159` `"swallowed save failure logs Failed to save history and retains in-memory turns"` | new green characterization |
| **Lossy `loadConversation` Null Collapse** | `conversation-persistence.ts:263-265` | `conversation-persistence.test.ts:1504` `"loadConversation: collapses an injected read failure to null without throwing"` | new green characterization (explicit owner policy / type gap) |
| **Synchronous Sidecar Removal on Delete** | `conversation-persistence.ts:376-421` | `conversation-persistence.test.ts:1536` `"deleteConversation: synchronously removes the residual delta sidecar with the canonical log"` | **repaired; green** (delete removes `.jsonl`, `.lock`, `.deltas`) |
| **Last Session Fallback & Staging Isolation** | `conversation-persistence.ts:298-307, 580-589` | `conversation-persistence.test.ts:441` `"loadLastConversation: returns the last written conversation"`, `:1562` `"saveLastConversation: leaves a parseable last.json file with no residual temporary files"`, `:1649` `"loadLastConversation: unpublished last.json temp sibling is ignored"`, `:1682` `"saveLastConversation: failed rename/publish leaves previous valid last.json loadable"` | existing tested invariant & new green characterization |
| **Typed Unreadable Project Resume (D1)** | `conversation-persistence.ts:294-320` | `conversation-persistence.test.ts:1818` `"loadConversationForProject: returns a typed unreadable result when read fails instead of propagating raw fs error"` | **repaired; green** (typed `{ status: 'unreadable', error }` instead of a raw `fs` crash) |
| **Distinct Temporary Staging Path (D3)** | `conversation-persistence.ts:645-662` | `conversation-persistence.test.ts:1851` `"saveLastConversation: uses a distinct temporary staging path for each save call"` | **repaired; green** (per-save `${lp}.${uuid}.tmp` staging) |
| **Corrupt Lock Diagnostic (D4)** | `conversation-persistence.ts:347-374` | `conversation-persistence.test.ts:1891` `"isConversationLocked: diagnostically distinguishes corrupt lockfile payload from live lock"` | **repaired; green** (`{ status: 'corrupt' }` distinct from held/stale) |
| **Stale Same-Host Lock Reporting** | `conversation-persistence.ts:45-60, 347-374` | `conversation-persistence.test.ts:1902` `"isConversationLocked: reports stale for a same-host lock whose PID is demonstrably dead"` & `:1927` `"same-host lock whose PID was reaped is stale through the production liveness path"` | new proof; green (injected + reaped-child liveness) |
| **Stale Same-Host Lock Reclaim** | `conversation-log-writer.ts:250-301` | `conversation-log-writer.test.ts:505` `"init reclaims a same-host lock whose PID is demonstrably dead"` & `:536` `"init reclaims a same-host lock whose PID was reaped, through the production liveness path"` | new proof; green (writer unlinks stale lock, retries once) |
| **Held vs. Foreign-Host Lock Attribution** | `conversation-persistence.ts:347-374` | `conversation-persistence.test.ts:1950` `"isConversationLocked: reports held for a same-host lock whose PID is alive"` & `:1962` `"cross-host lock is reported held even with an unprovable PID"` | new proof; green |
| **History Corrupt Quarantine (D5)** | `history-service.ts:104-112, 117-135` | `history-service.test.ts:196` `"preserves or quarantines corrupt history file on write instead of destroying it"` | **repaired; green** (quarantine before valid replacement write) |
| **Atomic History Save (D6)** | `history-service.ts:138-158` | `history-service.test.ts:218` `"atomic save preserves prior durable history when write fails mid-operation"` | **repaired; green** (same-directory temp + rename) |

## 9. Verification commands

### Focused Verification Gate

```bash
NODE_ENV=test pnpm test \
  source/services/conversation/conversation-persistence.test.ts \
  source/services/logging/conversation-log-writer.test.ts \
  source/services/history-service.test.ts \
  source/services/conversation/conversation-replay.test.ts
```

**Result on 2026-08-15:** 4 test files, 166 tests, 166 passed (0 expected failures).
The five previously retained red proofs (D1, D3, D4, D5, D6) plus the new
synchronous sidecar-removal and stale-lock liveness proofs are all green after
repair.

### Broader Gates

- `pnpm typecheck` — clean exit code 0.
- `NODE_ENV=test pnpm test` — runs full unit suite (retains single known unrelated settings-schema baseline failure: `maxModelRequestDurationMs` default expected `0` vs received `300000`).
- Prettier check and `git diff --check` — clean exit code 0.

## 10. Known gaps, defect classifications, and owner decisions

### Proven Product Defects (Repaired 2026-08-15)

1. **D1 — `loadConversationForProject` Raw Read Error Propagation:**
   - *Defect:* `loadConversationForProject` had no error handling around `readEnvelopes`, letting raw `fs.readFileSync` exceptions crash CLI startup with a stack trace.
   - *Repair:* Returns a typed result `{ status: 'unreadable', error }`; `cli.tsx` prints an actionable diagnostic and exits 1.
   - *Proof:* `conversation-persistence.test.ts:1818` (green).

2. **D3 — Non-Distinct `last.json` Temporary Staging Path:**
   - *Defect:* `writeLastConversationFile` used a fixed temp path `${lp}.tmp` (`last.json.tmp`), so consecutive or overlapping saves staged to identical filenames.
   - *Repair:* Each save stages to a distinct `${lp}.${uuid}.tmp` and unlinks it in a `finally`.
   - *Proof:* `conversation-persistence.test.ts:1851` (green).

3. **D4 — Corrupt Lockfile Masquerading as Active Holder:**
   - *Defect:* `isConversationLocked` returned `{ pid: -1, startedAt: '', host: '' }` for unparseable locks, masquerading as an active holder.
   - *Repair:* Returns a discriminated `{ status: 'corrupt' }` (plus `held`/`stale` statuses); `cli.tsx` distinguishes corrupt refusal.
   - *Proof:* `conversation-persistence.test.ts:1891` (green).

4. **D5 — HistoryService Overwriting Corrupted History on Write:**
   - *Defect:* `HistoryService.load()` reset `messages = []` on parse failure and the next `save()` destroyed the corrupt file.
   - *Repair:* The first save quarantines the corrupt bytes as `history.json.corrupt.<ts>` before publishing a valid replacement; a failed quarantine refuses the replacement write.
   - *Proof:* `history-service.test.ts:196` (green).

5. **D6 — Non-Atomic History File Save:**
   - *Defect:* `HistoryService.save()` wrote directly to `historyFile`, so an interrupted or failing write truncated the file.
   - *Repair:* Stages to a same-directory `.history.json.<uuid>.tmp` and atomically renames over the destination.
   - *Proof:* `history-service.test.ts:218` (green).

6. **Residual `.deltas` on `deleteConversation`:**
   - *Defect:* Explicit delete removed the canonical `.jsonl` and `.lock` but left the `.deltas` sidecar on disk until the next launch's orphan GC.
   - *Repair:* `deleteConversation` synchronously removes the `.deltas` sidecar with the canonical log.
   - *Proof:* `conversation-persistence.test.ts:1536` (green).

7. **Stale Same-Host Lock Deadlock:**
   - *Defect:* A lockfile left by a process that exited without releasing (crash/kill) blocked subsequent writers forever with `LockConflictError`, and `isConversationLocked` could not distinguish it from a live holder.
   - *Repair (owner-decided liveness path):* `isPidAlive` probes the holder PID with signal 0 (never delivering a signal; `ESRCH` = dead, `EPERM` = alive but foreign). Only same-host locks are probed. `isConversationLocked` reports `{ status: 'stale' }`; the writer's `acquireLock` unlinks a stale lock and retries once. Corrupt payloads, live PIDs, and foreign-host locks still raise/refuse.
   - *Proofs:* `conversation-persistence.test.ts:1902, 1927, 1950, 1962` and `conversation-log-writer.test.ts:505, 536, 566` (green). The liveness probes are injectable (`setPidAlivenessCheckForTest`), so proofs control PID liveness deterministically and never signal arbitrary real PIDs.

### Policy Choices (Owner Decisions Taken 2026-08-15)

- **Stale Lock Liveness:** Resolved by the repair above. Residual limits: PID reuse after a crash is not detectable (a recycled PID is treated as a live holder, which is the safe direction), and foreign-host locks are never probed.
- **Delete-to-Launch Privacy Window:** Resolved — `deleteConversation` removes the sidecar synchronously; `collectOrphanedDeltaSidecars` remains for crash-orphaned sidecars only.

### Policy Choices Awaiting Owner Decision

- **Multi-Process Shared-Index Concurrency:** Unique temporary staging paths (D3) prevent staging file clobbering, but do not provide full transactionality or distributed locking across multiple processes updating `last.json` concurrently. Owner must decide if `last.json` requires advisory locking or journaled index updates.
- **Lossy `loadConversation` Null Collapse:** Sibling `loadConversation` catches all errors and returns `null`, collapsing missing, corrupt, permission-denied, and mismatched contexts into a single generic failure. Owner must decide whether `loadConversation` should adopt typed failure returns.
- **Post-Close Writer Policy:** Appending events after `close()` currently drops them silently. Owner must decide whether post-close appends should throw, warn in telemetry, or remain silent no-ops.
- **Timestamp Priority for Session Sorting:** `updatedAt` currently has three competing representations in the codebase: last envelope timestamp (`restoredUpdatedAt`), file modification time `mtime` (`listConversations`), and `last.json` write time. Owner should standardize resume recency ranking.
