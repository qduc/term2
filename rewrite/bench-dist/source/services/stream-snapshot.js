/**
 * Snapshot types for AgentStream internals.
 *
 * These types describe what ConversationSession needs from the stream,
 * not what the SDK happens to store internally. This creates an honest
 * boundary: "our adapter can produce the data the session needs," not
 * "AgentStream has these properties."
 */
const asArray = (value) => (Array.isArray(value) ? value : []);
/**
 * Extract replay inspection snapshot from an AgentStream.
 * All SDK-specific casts are isolated here.
 */
export const extractReplaySnapshot = (stream) => {
    const streamRecord = stream;
    return {
        history: asArray(streamRecord.history),
        newItems: asArray(streamRecord.newItems),
    };
};
/**
 * Extract finalization snapshot from an AgentStream.
 * All SDK-specific casts are isolated here.
 */
export const extractFinalizationSnapshot = (stream) => {
    const streamRecord = stream;
    return {
        history: asArray(streamRecord.history),
        newItems: asArray(streamRecord.newItems),
        output: asArray(streamRecord.output),
        lastResponseId: stream.lastResponseId ?? null,
    };
};
/**
 * Extract history length for retry classification.
 * Returns 0 if stream is null or has no history.
 */
export const extractHistoryLength = (stream) => {
    if (!stream)
        return 0;
    const streamRecord = stream;
    return Array.isArray(streamRecord.history) ? streamRecord.history.length : 0;
};
//# sourceMappingURL=stream-snapshot.js.map