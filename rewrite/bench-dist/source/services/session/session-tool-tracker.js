/** Presentation caches only; accepted tool evidence belongs to ConversationRecord. */
export class SessionToolTracker {
    toolCallArgumentsById = new Map();
    emittedInvalidToolCallPackets = new Set();
    emittedToolStartedCallIds = new Set();
    emittedSubagentToolStartedIds = new Set();
    emittedCommandMessageIdsByCallId = new Map();
    snapshotArguments() {
        return new Map(this.toolCallArgumentsById);
    }
    /** Work on a detached segment view; only a current generation commits it. */
    beginProjection(preserveArguments) {
        const argumentsById = preserveArguments ? this.snapshotArguments() : new Map();
        const invalidPackets = new Set(this.emittedInvalidToolCallPackets);
        return {
            argumentsById,
            invalidPackets,
            commit: () => {
                this.toolCallArgumentsById = new Map(argumentsById);
                for (const packet of invalidPackets)
                    this.emittedInvalidToolCallPackets.add(packet);
            },
        };
    }
    /** A settled result allows a later provider reuse of the call id to render anew. */
    noteResultObserved(callId) {
        this.emittedToolStartedCallIds.delete(callId);
    }
    dedupeToolStarted(event) {
        if (event.type === 'subagent_tool_started') {
            const key = `${event.agentId}:${event.toolCallId}`;
            if (this.emittedSubagentToolStartedIds.has(key)) {
                return null;
            }
            this.emittedSubagentToolStartedIds.add(key);
            return event;
        }
        if (event.type !== 'tool_started') {
            return event;
        }
        if (this.emittedToolStartedCallIds.has(event.toolCallId)) {
            return null;
        }
        this.emittedToolStartedCallIds.add(event.toolCallId);
        return event;
    }
    /**
     * Remember which command message ids a call emitted. Message ids come from the tool's formatter
     * (`<provider item id or call id>-<n>`), so they cannot be derived from the call id later.
     */
    noteCommandMessageEmitted(message) {
        if (!message.callId)
            return;
        const ids = this.emittedCommandMessageIdsByCallId.get(message.callId) ?? [];
        ids.push(message.id);
        this.emittedCommandMessageIdsByCallId.set(message.callId, ids);
    }
    /**
     * Command message ids emitted by an earlier execution of this call id, which a new execution that
     * reuses the id must not be deduped against. Forgets them.
     */
    takeCommandMessageIdsOfEarlierExecution(callId) {
        const ids = this.emittedCommandMessageIdsByCallId.get(callId) ?? [];
        this.emittedCommandMessageIdsByCallId.delete(callId);
        return ids;
    }
    clearArguments() {
        this.toolCallArgumentsById.clear();
    }
    /**
     * Clear emitted tool started call IDs.
     */
    clearEmittedToolStarted() {
        this.emittedToolStartedCallIds.clear();
        this.emittedCommandMessageIdsByCallId.clear();
    }
}
//# sourceMappingURL=session-tool-tracker.js.map