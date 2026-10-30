export const LOG_ENVELOPE_VERSION = 3;
/**
 * Streaming `assistant_journal_delta` events are written to a per-session
 * sidecar instead of the canonical log. They are only ever read to reconstruct
 * a turn that never produced a final `assistant_turn`, so the sidecar is
 * dropped when a session closes with no unsettled turn.
 *
 * The suffix deliberately does **not** end in `.jsonl`: `listConversations`
 * enumerates the conversations directory with a `*.jsonl` glob and would
 * otherwise surface the sidecar as a phantom conversation.
 */
export const DELTA_SIDECAR_SUFFIX = '.deltas';
/** Map a canonical `<sessionId>.jsonl` path to its delta sidecar path. */
export function deltaSidecarPathFor(logFilePath) {
    return logFilePath.replace(/\.jsonl$/, '') + DELTA_SIDECAR_SUFFIX;
}
/** Event types routed to the delta sidecar rather than the canonical log. */
export const SIDECAR_EVENT_TYPES = new Set(['assistant_journal_delta']);
/**
 * Narrowing predicate for the storage-only truncation marker. Uses an `in`
 * check (plus an explicit `=== true`) rather than the `type` discriminant
 * because `TruncatedLogEvent.type` is a plain `string` that overlaps with
 * every log-event type.
 */
export function isTruncatedLogEvent(event) {
    return 'truncated' in event && event.truncated === true;
}
export const AGENT_AFFECTING_SETTINGS = new Set([
    'agent.modelSelection',
    'agent.reasoningEffort',
    'agent.temperature',
    'app.activeProfileId',
]);
//# sourceMappingURL=conversation-log-events.js.map