# Event-sourced session and provenance

Status: **design only; no implementation is claimed by this document.**

## Resume here

The current session journal already supplies a useful event-sourced foundation: version-3 JSONL envelopes have a monotonic `seq`, `ConversationLogWriterImpl` appends canonical lifecycle events, and `replayEvents` derives transcript, provider history, tool ledger, and resumable metadata. Do not replace this format or make provider wire payloads the canonical conversation.

The gap is that some durable records are already projections or checkpoints without durable event-level coverage, and some state remains in sidecars or runtime owners. In particular, local compaction stores `replacesThroughRevision` (an in-memory history revision, not a durable event identity); native provider compaction is represented by provider-opaque history; `assistant_turn` and undo snapshots persist provider-history state; and streaming deltas live in `.deltas` until settlement. Thus this is not yet a single authoritative, structurally traceable record of source events and their derived artifacts.

### Gap measurement (verified starting state)

| Surface | Already true | Remaining gap against the goal |
| --- | --- | --- |
| Durable log | `LogEnvelope` is `{v, seq, ts, event}`; canonical JSONL and `.deltas` share a sequence; writer appends and recovery merges by `seq` (Contract 08, `ConversationLogWriterImpl`, `readEnvelopes`). | `seq` is only unique within a log; deltas are a separately retained crash-recovery stream and are discarded after clean settlement. There is no stable event reference in derived data. |
| Replay/UI | `replayEvents` folds events into messages, ledger, usage, metadata, and history; interrupted journals are reconstructed without automatically re-running work. | `RestoredState` is a projection; no general durable projection cursor or source-event provenance accompanies it. UI-only state and live queues/interactions are not reconstructed from conversation events. |
| Provider context | `assistant_turn` reconstructs a portable transcript; native opaque state is provider-tagged and filtered at provider adapters (Contract 02). | Provider history is partly a separately persisted projection/snapshot, not fully derivable from canonical semantic events. `previousResponseId` and active provider-side anchors are continuity state, not replayable portable history. |
| Compaction | Local compaction preserves a hot tail, validates fit and pair integrity, and commits against a store revision; native compaction remains opaque. | Local checkpoint provenance uses ephemeral revision metadata, not source event references. Context replacement can discard old context from the provider request but must not delete source events. |
| Fork/rollover | `forkConversation` atomically copies settled canonical history and rewrites `session_init` identity with `forkedFrom`; rollover records predecessor identity in `session_init.rolloverFrom`. | Fork copies history as a snapshot and does not retain unsettled `.deltas`; lineage and per-artifact provenance need a stable representation across copies. |
| Other persistence | Foreground queued text is persisted in a versioned queue sidecar (Contract 12); composer history is separate. | Queue/steer state and pending approvals are not uniformly represented as conversation-log events. They must not be mislabeled as derivable from the conversation log. |

These findings are based on `conversation-log-events.ts`, `conversation-log-writer.ts`, `conversation-persistence.ts`, `conversation-replay.ts`, `conversation-state-projector.ts`, `local-context-compactor.ts`, `session-composition.ts`, `provider-input.ts`, Contracts 02/08/12, and the linked plans.

## Goal and invariants

Make each session's append-only semantic event history authoritative for what Term2 observed and durably committed. Replay derives the UI transcript, provider-neutral history, tool-effect ledger, and session metadata from that history. Provider request context is a projection of the durable semantic history plus explicitly scoped derived checkpoints; it is not a second authoritative transcript.

1. **Append-only source:** ordinary operation adds events; compaction never edits, removes, or rewrites historical source events. Explicit user deletion remains deletion, outside compaction. A fork creates a new branch/log and does not mutate its parent.
2. **Stable references:** every canonical source event has a stable event ID. Every derived artifact declares the exact event IDs it represents (or an explicitly complete contiguous range plus its log identity). IDs survive replay and fork-copy; a reference can be resolved to original event bytes.
3. **One policy owner:** the session journal owns event sequencing, durable append, event identity, and schema compatibility. Replay owns projections; compaction owns summary content and source coverage; continuity owns provider-chain state. No generic event-store framework is introduced.
4. **Provider neutral:** canonical event types describe user/assistant/tool, approval, session, and application-observed lifecycle facts. Do not place vendor request/response wire shapes or opaque tokens into semantic events. Provider-native artifacts remain provider-scoped adjuncts, filtered by the existing adapter compatibility policy, never cross-provider context.
5. **No invented history:** a summary is a lossy model-facing projection, not a replacement for source events and not a UI transcript entry. Replaying a session preserves genuine user turns and completed effects; it never re-executes tools or resumes an approval automatically.
6. **Distinguish guarantees:** local append-log replay, provider-side retained state, ephemeral UI state, queued text, and interrupted streaming recovery have separate ownership and durability claims. Do not call the complete application state event-sourced until each required durable owner is explicitly represented or declared out of scope.

## Proposed event and provenance model

Retain the JSONL envelope and monotonic sequence. Add an optional persisted `eventId` to new envelopes, generated once before append. Legacy events without it receive a read-time deterministic reference from their immutable log identity and sequence; do not rewrite old envelopes merely to backfill IDs. The stable reference shape is `{ logId, eventId }`, where `logId` is the immutable identity of the journal stream. Sequence remains an ordering and diagnostic field, not a cross-fork identity. `forkedFrom` / a fork event records lineage separately from the new stream identity. During migration, retain the existing session ID as `logId`; a forked copy must preserve source event IDs and record that it is a copied branch, rather than silently assigning new identities to inherited events.

Derived artifact records are append-only events in the same journal. A `context_checkpoint_created` event contains:

- stable `artifactId` and checkpoint kind (`local_summary` or `provider_opaque`);
- `sourceRefs`: exact source event references covered, sorted by source-log sequence, and `sourceDigest` over the ordered references (and canonical payload bytes where practical);
- the checkpoint's portable summary body for local summaries; provider identity and a separately stored opaque artifact reference for native state;
- `createdAtRevision` only as optional diagnostics, never as provenance;
- algorithm/version and estimates as non-authoritative metadata.

Use explicit references for coverage rather than a bare sequence range in the first version: undo, user-turn safe cuts, fork lineage, interrupted deltas, and filtered non-model events can make an apparent interval misleading. A range encoding may be a storage optimization only when it is validated to resolve to exactly the same ordered event set. Checkpoint publication is atomic with the projection update: append the successful checkpoint event only after generation, fit validation, and revision/source-prefix validation pass. Failed, cancelled, stale, or refused compaction emits no successful checkpoint record; preserve existing lifecycle notices and record failures only where the current lifecycle already records them.

Native provider compaction is a special case: the semantic log records that a provider-scoped checkpoint was accepted and its owner/provider identity, but does not copy or interpret opaque wire contents as portable semantic history. Only include `sourceRefs` if the provider adapter can establish which application event set the opaque artifact summarizes. Otherwise mark coverage as unknown and require a self-contained portable history before another provider is selected. This avoids falsely claiming provenance.

### What is / is not derivable

- **Derivable after migration:** finalized user and assistant transcript, observed tool calls/results and settled statuses, approvals requested and resolved, settings/profile changes, user/launcher-authored bounded goal changes (`goal_changed`), session/fork/rollover lineage, and application-owned summary checkpoints.
- **Not inherently derivable:** server-side response IDs or provider cache state, unobserved tool effects, transient UI focus/selection, live process handles, pending interactive approval prompts, and in-memory pending steer. Keep chain anchors ephemeral/provider-scoped and clear them on restart unless the existing adapter contract safely resumes them. Record effect ambiguity as `unknown`; do not replay it.
- **Separate durable sidecars:** the queue sidecar remains owned by Contract 12 until a deliberate migration chooses otherwise. It records admitted text ownership, not completed conversation history. Do not fold it into this project merely to claim a single file.

## Persistence and compatibility

- New envelopes remain backward-readable v3-compatible JSON objects with optional fields; decoder accepts legacy envelopes unchanged. If adding event IDs requires a version increment, decoder must read v2/v3 and new versions, while old writers continue to read unknown optional fields.
- Do not rewrite existing JSONL on load, compaction, fork, or upgrade. Read missing IDs using deterministic, per-record references; write IDs only on newly appended events. Deduplicate only repeated explicit persisted event IDs (first occurrence wins). Preserve structurally valid records with repeated or non-monotonic sequence values so legacy replay output is unchanged; sequence validation may diagnose corruption but must not filter distinct records.
- `.deltas` is logically part of the event stream while an unsettled turn exists: preserve unified ordering and read compatibility. Clean-close deletion remains acceptable only after the deltas have been durably folded into canonical semantic events. Before changing that lifecycle, prove a crash between settlement and fold cannot lose the final transcript.
- Existing `assistant_turn` and undo `snapshot` fields remain accepted during migration. Treat them as versioned compatibility projections, not new sources of truth. New events should persist semantic operations sufficient for replay; stop writing redundant provider-history snapshots only after replay equivalence and old-file compatibility are proven.
- Existing `forkConversation` copies settled history; preserve this user behavior. Future fork events establish the child stream and parent refs without modifying parent bytes. Legacy fork files remain readable as-is.
- Corrupt/unknown event behavior remains fail-soft as in Contract 08, but a checkpoint whose references do not resolve is not applied to model context; fall back to full safe history or a typed refusal, never silently apply an unverifiable summary.

## Milestones

Each milestone is independently mergeable. Run focused tests during work, `pnpm test:related` after a coherent source slice, and `pnpm test:changed` plus `pnpm typecheck` at handoff. These are cross-module persistence contracts, so the final milestone that changes replay/write behavior also requires `pnpm test:integration`; do not run the full suite unless the change expands into broadly imported behavior or configuration. Any run-loop/provider bridge changes additionally require `pnpm test:provider-black-box` per the provider testing skill. No test-tier membership change is proposed.

### M1 — stable event identity and compatibility reader

Add optional `eventId`, immutable stream identity, validation, and deterministic legacy references at the envelope/decoder seam. Preserve the `.deltas` shared sequence and all existing v2/v3 read behavior. Do not change replay output.

- Contracts: Contract 08 (envelope identity, compatibility decoding, append invariants); Contract 02 is unchanged.
- Tests: decoder roundtrips, legacy IDs stable and unique across repeated sequences, explicit duplicate-ID and malformed-line behavior, sequence restarts and repeated sequences retained in replay, unified canonical/sidecar ordering, fork copies preserve source IDs, and old fixtures replay identically.
- Preservation: no event rewrite or projection change; current lock, fsync, sidecar, and recovery behavior remains the authority.

### M2 — semantic event completeness and replay equivalence

Inventory and emit semantic events for state currently reconstructed only from provider-history snapshots. Add a pure replay projection that derives transcript, provider-neutral history, metadata, and tool ledger from source events, retaining a compatibility adapter for old snapshots. Keep ephemeral provider chain IDs outside the canonical semantic projection. Distinguish observed completion from dispatched-but-unknown and never auto-dispatch on replay.

#### M2 inventory (verified in the current implementation)

The current replay fold is `replayEvents` in `source/services/conversation/conversation-replay.ts`. It already derives transcript, provider-facing history, tool ledger, usage/cost metadata, goal, session identity, and profile/model/provider metadata from journal events. The live provider-history projection is separately owned by `conversation-state-projector.ts`.

| State | Current durable source | Snapshot-only? | M2 treatment |
| --- | --- | --- | --- |
| User transcript | `user_message`; old-format compatibility decoding | No | Keep semantic event as source. |
| Assistant transcript and portable provider history | `assistant_turn.turn` for settled turns; `assistant_journal_item` / `assistant_journal_delta` for interrupted turns | No, for current event formats | Replay from semantic turn items; characterize old v2 formats. |
| Tool effect ledger and provider call/result pairs | `tool_started`, `tool_result`, plus assistant-turn items; v2 `assistant_turn.snapshot.toolLedger` is a compatibility override | Partly (legacy v2) | Preserve observed completion and `unknown`; never execute during replay. |
| Undo-restored provider history, ledger, and previous response anchor | `undo.snapshot` | **Yes** | This is the primary remaining snapshot dependency. A snapshot-free undo event needs an explicit semantic retraction/reset representation; simply dropping the snapshot changes model input and ledger. |
| Provider chain anchor at successful turn boundary | v3 `assistant_turn.state.previousResponseId`; v2 `assistant_turn.snapshot.previousResponseId` | Legacy only, and not portable semantic state | Exclude from the canonical semantic projection; preserve as provider continuity compatibility input only, then invalidate on restart/model-provider change. |
| Model/provider and profile metadata | `session_init`, `settings_changed`; legacy turn snapshot model/provider participates in chain invalidation | No for current event formats; legacy snapshot contributes compatibility diagnostics | Derive metadata from explicit events, keep old snapshot decoder. |
| Approval lifecycle | `approval_required`, `approval_resolved`, tool lifecycle events | No | Replay as history/observation only; never restore a live approval. |
| Goal | versioned `goal_changed` | No | Already semantic and independent from chat text. |
| Foreground queued text / pending interaction | Contract 12 sidecar and interaction owner | Not a conversation-log snapshot | Keep outside M2 projection; preserve explicit no-auto-dispatch recovery. |

Observed event inventory already includes semantic `user_message`, `assistant_journal_item`, `assistant_journal_delta`, `tool_started`, `tool_result`, `approval_required`, `approval_resolved`, `settings_changed`, `session_init`, and `goal_changed`. Avoid adding a second generic event-store vocabulary. The remaining event-design work is a narrowly defined undo/retraction operation. Existing `tool_result.status` and assistant-turn tool items now preserve `unknown` through decoding, replay, the ledger, and transcript presentation; regression coverage pins that distinction.

**M2a boundary:** add/characterize semantic coverage and a comparison-only pure projection, with the existing replay authoritative. Keep all old snapshot decoding. A production switch is explicitly out of scope until stored fixtures and the complete read-only corpus have zero categorized mismatches. M2b can then remove new snapshot writes only after undo semantics and provider-history equivalence are proven. Never interpret queue sidecars or provider chain IDs as canonical semantic history.

- Contracts: Contract 08 (event fold and resume), Contract 02 (tool-pair settlement, opaque isolation, chain invalidation), Contract 12 only at its existing queue recovery join; no transfer of queue ownership is implied.
- Tests: golden old-log/new-log replay equality for transcript and provider input; interrupted turns and approvals; complete/partial parallel tools; unknown effects; model/provider switch; clear, undo, fork, and rollover; provider black-box characterization if run-loop dispatch semantics change.
- Preservation: stage behind dual-projection comparison; retain old decoder and snapshot handling until stored-session fixtures match. Restart clears unsafe chain anchors and does not resume approvals or effects.

### M3 — provenance-bearing local compaction

Replace local summary's revision-only provenance with exact `sourceRefs` and digest. Append a successful checkpoint-created event only at the existing compaction commit point, then derive the model projection from source events plus that checkpoint and hot tail. Keep all original source events; do not rewrite the journal. Reject stale, incomplete, or unresolvable coverage. Keep existing safe-cut, paired-effect, fit, hysteresis, and cancellation behavior.

- Contracts: Contract 02 (replacement boundaries and ledger reconciliation), Contract 08 (append-only checkpoint persistence and replay), and provider-neutral-context-compaction plan's milestone 1/atomic revision rule.
- Tests: exact source coverage after normal and repeated compaction; idempotent replay, hot-tail preservation, stale revision and missing-reference refusal, compaction crash before/after checkpoint append, old checkpoint migration, and save/resume equality. Run provider black-box only if request construction or chain behavior changes.
- Preservation: existing provider context remains checkpoint + hot tail; transcript keeps genuine source turns; provider continuity still clears at replacement and effect ledger never resurrects effects before the cut.

### M4 — native checkpoint and branch lineage

Record native opaque checkpoint ownership and source coverage only where provable; otherwise retain provider-scoped opaque state as an adjunct and force safe full-history rebuilding when switching providers. Make future fork creation add branch lineage without rewriting source event identities. Keep rollover's predecessor semantics.

- Contracts: Contract 02 (provider-scoped opaque state and chain), Contract 08 (fork atomicity, lineage and backward compatibility), rollover plan (`session_init.rolloverFrom`) at the shared session identity seam.
- Tests: same-provider opaque preservation and foreign-provider non-serialization; unknown-coverage refusal; fork bytes and parent immutability; nested fork provenance; rollover parent lookup and legacy session-init replay.
- Preservation: no change to provider adapters' fail-closed policy, fork visible transcript, or rollover interaction/settlement guards. Do not claim native summary provenance unsupported by an adapter.

## Cross-task contracts

- **T2 runtime capability seams:** the session journal offers append/read operations and event-reference resolution, not a runtime plugin registry. Runtime capabilities may observe canonical lifecycle events through an existing session-owned seam; they must not own sequencing, persistence, or redefine event types. T1 does not prescribe T2 interface/module structure.
- **T3 durable goal:** goal changes are user-authored semantic `goal_changed` events appended through the journal's normal append path and receive stable event IDs like any other event. T1 owns sequencing and identity; T3 owns the goal schema and lifecycle. Goal state is never inferred from conversation text.
- Event types needed across tasks are limited to stable envelope identity, semantic conversation/lifecycle events, checkpoint-created provenance, and branch lineage. Do not couple the shared event format to provider wire types or goal/runtime capability payloads.

## Open decisions

1. **Event reference storage:** Should provenance store every event ref, or compress verified contiguous source runs? Recommendation: start with exact refs; optimize only after measured log-size evidence and equivalence tests.
2. **Native compaction coverage:** Can each adapter expose a trustworthy source mapping for opaque native checkpoints? Recommendation: default to `coverage: unknown`; only claim provenance when adapter evidence proves it.
3. **Sidecar settlement:** Should settled deltas be retained in canonical JSONL permanently or folded before sidecar deletion? Recommendation: fold semantic final events into the log before deleting the crash journal, then prove crash-safe ordering in Contract 08. Do not change this until that ordering is specified.
4. **Queue and pending interaction scope:** Should queue/approval ownership eventually share the session journal? Recommendation: not in T1. Keep Contract 12's sidecar and approval owner until a separate contract migration can preserve its no-auto-dispatch and pending-interaction guarantees.
5. **Fork identity compatibility:** How should legacy forks that rewrote `session_init.id` map to immutable `logId`? Recommendation: treat the existing file's current ID as its log identity; preserve inherited event IDs when present and use deterministic local legacy refs without rewriting old forks.

## Unverified claims and evidence limits

- The assignment's claim that compaction never rewrites/deletes historical events is consistent with the inspected local history-replacement path, but all native compaction persistence and every session-reset/fork path were not exhaustively traced. Verify before implementation; explicit user deletion is outside the compaction invariant.
- “Every UI state is derivable” is intentionally not asserted: transient Ink state, live handles, queue sidecars, pending interactions, and provider-side anchors have separate owners and durability semantics.
- Provider-native opaque payloads cannot be semantically source-mapped by inference. Adapter-specific proof is a prerequisite for `sourceRefs`.

## Related contracts and plans

- [Contract 02 — provider input, continuity, and effect settlement](../contracts/02-provider-input-continuity-and-effect-settlement.md)
- [Contract 08 — conversation durability and recovery](../contracts/08-conversation-durability-and-recovery.md)
- [Contract 12 — queue persistence and recovery](../contracts/12-queue-persistence-and-recovery.md)
- [Provider-neutral context compaction](provider-neutral-context-compaction.md)
- [OpenAI context compaction](openai-context-compaction.md)
- [Session rollover handoff](session-rollover-handoff.md)
- [Chain settlement](chain-settlement.md)
- [Context lifecycle/session handoff](context-lifecycle-session-handoff.md)
- [Session query index](session-query-index.md)
