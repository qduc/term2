# Contract 12 — Queue Persistence and Recovery

**Status:** audit draft; awaiting owner review

## 1. Contract

| ID | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C12.1 | Admitted foreground queue ownership is written as one versioned JSON sidecar and atomically replaced after each ownership mutation. | A restart silently drops a follow-up, or a partial write corrupts the live queue record. |
| C12.2 | Load validates the version, IDs, item fields, and strictly increasing sequences. An invalid or unreadable record is quarantined and exposed as `invalid_persisted_queue`; no prefix is executed. | Corrupt bytes auto-start the wrong work or execute only part of a queue. |
| C12.3 | Restore never auto-starts a provider turn, tool, approval, or interrupted `active` item. Retained queued work is `paused` and requires `resume_queue`; interrupted active work is dropped, not replayed. | A crash blindly re-dispatches a side-effecting command or continues unpaid provider/tool-chain debt. |
| C12.4 | Recovery with no retained queued items collapses to `idle`, rather than an empty `paused` state. | Resuming a session that died with only its active turn does not lock the composer behind “0 item(s) pending.” |
| C12.5 | Persisted item identity is text-only: `{ id, text, sequence, submittedAt, steer?, preflight? }`. A recovered reserved non-text placeholder is not passed to `turnFlow.start`; when another retained item exists, it produces a controller failure/pause. | Recovery is bounded to the persisted text identity; reserved non-text placeholders are rejected rather than dispatched as user input. |
| C12.6 | A persistence write failure does not report durable success: `replace()` throws are surfaced as `persistence_failed` while the in-memory mutation remains available. | The UI cannot imply that a queue mutation was saved when the sidecar write failed. |

**Not claimed:** `fsync`, power-loss durability, crash simulation, two writers for one session, or pending-steer durability.

## 2. Owners

**Enforcement**

- `QueueController.#persist`, `#restore`, and persisted-record validation in `source/services/queue/queue-controller.ts`.
- `createSessionQueuePersistence` in `source/services/conversation/queue-persistence.ts`.
- `ConversationAdapter.#runQueuedTurn` in `source/services/conversation/conversation-adapter.ts` for recovered text and fail-closed placeholder handling.
- `createConversationAdapterForRuntime` for production enablement and test-environment disablement.

**Recovery**

- `QueueController.#restore` conservatively pauses retained work and quarantines invalid loads.
- `resume_queue` and `discard_queue` are explicit recovery commands.
- The adapter’s recovered-start observer and `ConversationOrchestrator` project a recovered turn without a parked pre-restart `sendMessage` promise.

**Not owners**

- Conversation journal persistence, provider continuity, the tool execution ledger, pending run-loop steers, and Ink queue-pause presentation. Contract 01 owns in-process submission identity and settlement; Contract 02 owns provider history and chain debt; draft Contract 08 owns the append-only journal and its sidecars.

## 3. Execution paths that share the contract

1. **Production interactive session:** the factory installs `createSessionQueuePersistence` for a foreground queue outside `isTestEnvironment()`. Each accepted command or event that mutates queue ownership persists a complete record.
2. **Tests and `isTestEnvironment()`:** disk persistence is intentionally omitted from the factory; low-level tests inject a persistence seam when they need to characterize the boundary.
3. **Same-session `--resume`:** the resumed conversation id is reused as `sessionId`, so `${sessionId}.queue.json` is loaded.
4. **New session or reset:** a new id uses a different sidecar; the old sidecar is not implicitly claimed by the new session.
5. **`--fork`:** the journal is copied to a new id, but this contract does not claim queue-sidecar copying. Fork behavior is a residual meeting point with the journal contract.
6. **Active plus retained queue:** restore drops the active item, retains the queued items, enters `recovered_interrupted`, and waits for `resume_queue`.
7. **Saved pause plus retained queue:** restore preserves `failure` or `manual`, with no auto-dispatch.
8. **Queued items without active or saved pause:** restore still pauses conservatively before paid work.
9. **Active with an empty queue:** restore settles `idle` with the interrupted execution id retained only as recovery diagnostic (R1 fixed in this packet; the previous empty `paused/recovered_interrupted` was retained as a red and re-observed before the repair).
10. **Invalid record or throwing `load()`:** expose `invalid_persisted_queue`, quarantine best-effort, and keep an empty idle controller.
11. **Throwing `replace()`:** retain the in-memory mutation and expose `persistence_failed`.
12. **Recovered text:** explicit `resume_queue` starts the next retained item with a new execution id and no pre-restart parked promise.
13. **Recovered non-text placeholder:** adapter throws before `turnFlow.start`; the controller receives `failed` and pauses if other work remains.
14. **Delete and fork sidecars:** not asserted here; queue-sidecar cleanup/copy policy belongs at the Contract 08 meeting point.
15. **Pending steer at restart:** intentionally lost because pending steers are in-memory run-loop state.

## 4. Identities and state crossing the boundary

- The live sidecar path is `path.join(getConversationsDir(), `${sessionId}.queue.json`)`.
- `PersistedQueueV1` contains `version: 1`, `nextSequence`, `queue[]`, and optional `pause` and `active` records.
- Each `PersistedQueueItem` contains `id`, `text`, `sequence`, `submittedAt`, and optional `steer` and `preflight` fields. `QueueController` writes no executable rich-turn payload.
- The adapter’s active snapshot is `{ requestId, recovered? }`; `#messagesById` does not cross the process boundary.
- Recovery kinds are `recovered_interrupted` with `interruptedExecutionId`, `invalid_persisted_queue` with detail, and `persistence_failed` with detail.
- An interrupted active snapshot and item are not restored as active controller state. Only its execution id remains as a diagnostic.
- A persisted preflight action id is reminted on restore when no evaluator is installed, so an old action token is not reused.

## 5. Settlement semantics

- **In-process success:** the adapter’s queued execution completes, the controller advances, and a parked `sendMessage` promise settles.
- **Recovered success:** no parked promise exists. The recovered-start observer and turn flow provide the new timeline; controller settlement is still observable through its state transition.
- **Failure before dispatch:** admission rejection settles the in-process request. A recovered item has no such promise.
- **Failure after recovered start:** the adapter emits `failed`; retained work pauses with `failure`. A non-text placeholder follows this fail-closed path.
- **Cancellation:** in-process cancellation is distinct from restart recovery. Restart drops ambiguous active work and pauses retained queue items; it does not replay the interrupted item.
- **Retry/resume:** `resume_queue` starts the next retained queued item with a new execution id. It does not retry the interrupted active item.
- **Write failure:** synchronous `replace()` throws are caught by the controller; memory stays mutated and recovery reports `persistence_failed`.

## 6. Observability

- `QueueController.state()` exposes `recovery` and, when paused, `reason`.
- The adapter queue-state observer exposes queue length, state kind, and pause reason. It does not forward `recovery.kind`.
- The recovered-start observer receives `{ requestId, input, suppressUserMessageDisplay? }`. Recovered text has no corresponding `#messagesById` entry.
- The UI presents a generic pause for `recovered_interrupted`; this contract does not expand that presentation surface.
- Diagnosis signals include a leftover sidecar, a pause after `--resume`, and `state().recovery` in controller tests. No structured queue-persistence log is claimed.

## 7. Public boundary under test

- `QueueController.command`, `QueueController.event`, and `QueueController.state` with an injected `QueuePersistence`.
- `createSessionQueuePersistence` through `load`, synchronous `replace`, and `quarantine` against an isolated `setConversationsDirForTest` directory.
- `ConversationAdapter` with injected `queuePersistence`, `resumeQueue`, queue-state observer, and turn-flow dependency.

Tests do not reach into private restore/persist methods or private adapter maps. They do not test `deleteConversation`, fork sidecar policy, provider history, or pending-steer durability.

## 8. Deterministic contract matrix

| Cell | Evidence | Status |
| --- | --- | --- |
| Persist mutations in order | `queue-controller.test.ts`: “persists concurrent submissions in mutation order” | covered (existing) |
| Conservative restore and no auto-start | `queue-controller.test.ts`: “recovers queued work conservatively after an interrupted active execution” | covered (existing) |
| Invalid record quarantined | `queue-controller.test.ts`: invalid persisted record characterization | covered (existing) |
| `load()` throw quarantined | `queue-controller.test.ts`: “reports a load throw as invalid persisted queue…” | covered (new) |
| Synchronous `replace()` throw | `queue-controller.test.ts`: “retains an in-memory mutation and reports persistence_failed…” | covered (new) |
| Saved `failure`/`manual` pause requires resume | `queue-controller.test.ts`: parameterized saved-pause characterization | covered (new) |
| Empty record restores idle | `queue-controller.test.ts`: “restores an empty record with no active work or pause as idle” | covered (new) |
| File adapter missing / replace / quarantine | `queue-persistence.test.ts` | covered (new) |
| Recovered text starts with no in-memory message | `conversation-adapter.test.ts`: recovered queued start observer characterization | covered (existing) |
| Recovered non-text fails closed | `conversation-adapter.test.ts`: “fails closed for a recovered non-text placeholder…” | covered (new) |
| Empty interrupted-active restore collapses to idle | `queue-controller.test.ts`: “restores an interrupted active execution with no retained queue as idle” | covered (new; R1 flipped) |
| Crash, `fsync`, power loss, two processes | — | out of scope |
| Pending-steer persistence | — | intentionally absent |
| Delete/fork sidecar policy | — | residual Contract 08 meeting point |

## 9. Verification commands

Run from the dedicated worktree, with `NODE_ENV=test` for Vitest:

```sh
NODE_ENV=test pnpm test \
  source/services/queue/queue-controller.test.ts \
  source/services/conversation/queue-persistence.test.ts \
  source/services/conversation/conversation-adapter.test.ts
pnpm typecheck
pnpm exec prettier --check \
  source/services/queue/queue-controller.test.ts \
  source/services/conversation/queue-persistence.test.ts \
  source/services/conversation/conversation-adapter.test.ts \
  docs/contracts/12-queue-persistence-and-recovery.md
git diff --check
```

The focused run for this packet is **93 passed** across 93 tests (R1 flipped to green). The ordinary R1 run was re-observed first and failed because the controller returned `paused` with `recovered_interrupted` and an empty queue; it was then flipped to an ordinary test with the controller repair.

Full-suite and gate results are reported with the implementation packet. The known unrelated full-suite baseline is the settings-schema assertion expecting `maxModelRequestDurationMs` `0` while receiving `300000`; it must not be relabeled as a Contract 12 failure.

## 10. Known gaps and classification

| Item | Classification |
| --- | --- |
| Empty paused restore when active exists and queue is empty | **Repaired in this packet.** The controller now settles `idle` and keeps `interruptedExecutionId` only as `recovery` diagnostic; the retained red R1 was re-observed and flipped green. |
| Rich `UserTurn` payloads across restart | **Documented limitation.** The sidecar persists text only; executable rich payloads remain in adapter memory. |
| Factory disables disk under test | **Intentional test seam.** |
| Pending steers at restart | **Intentional in-memory state.** |
| Delete/fork ignore or do not copy `.queue.json` | **Residual Contract 08 meeting point; not a red in this packet.** |
| No `fsync`, crash-killed writer, or two-process simulation | **Out of scope and unobservable in this characterization slice.** |
| Adapter observer omits `recovery.kind` | **Presentation/coverage gap; pause reason remains observable.** |
| Snapshot richer in behavior prose than current `{requestId,recovered?}` | **Spec-vs-code characterization, not a durability claim or red.** |
| `queuedTurnStartObserver` ordering | **Retain-current decision (VP):** the observer fires before placeholder validation and may expose a recovered marker before failure. Kept as-is; not a product defect and not a new red in this packet. |
| Lone recovered non-text placeholder | **Retain-current decision (VP):** it may return `idle` after failure because there is no retained work and no parked pre-restart promise. Kept as-is; not a product defect and not a new red in this packet. |
| Legitimate text equal to the reserved placeholder marker | **Retain-current decision (VP):** it is indistinguishable from the reserved non-text marker after restart. Kept as-is; not a product defect and not a new red in this packet. |
