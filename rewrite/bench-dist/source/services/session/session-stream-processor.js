import { normalizeRunItem } from '../conversation/run-item-normalizer.js';
import { createStreamAccumulator, processStreamEvents } from '../stream-event-processor.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { resolveSessionId } from './session-identity.js';
export class SessionStreamProcessor {
    deps;
    #toolCallMarkers;
    constructor(deps) {
        this.deps = deps;
        this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
    }
    /**
     * Projects accepted events, dedupes display events and returns presentation data.
     */
    async *process(stream, options) {
        const acc = createStreamAccumulator();
        if (options.previouslyEmittedCommandIds) {
            acc.emittedCommandIds = new Set(options.previouslyEmittedCommandIds);
        }
        if (!this.deps.generationGuard.isCurrent(options.gen)) {
            return acc;
        }
        const projection = this.deps.toolTracker.beginProjection(options.preserveExistingToolArgs);
        const generator = processStreamEvents(stream, acc, {
            toolCallArgumentsById: projection.argumentsById,
            emittedInvalidToolCallPackets: projection.invalidPackets,
            preserveExistingToolArgs: true,
            markerStore: this.#toolCallMarkers,
            onFunctionResultItem: (item) => {
                for (const normalized of normalizeRunItem(item)) {
                    if (normalized.type === 'tool_result')
                        this.deps.toolTracker.noteResultObserved(normalized.callId);
                }
            },
        }, { logger: this.deps.logger, sessionId: resolveSessionId(this.deps.sessionId) });
        const iterator = generator[Symbol.asyncIterator]();
        let closed = false;
        try {
            while (true) {
                if (!this.deps.generationGuard.isCurrent(options.gen)) {
                    await iterator.return?.();
                    closed = true;
                    return acc;
                }
                const next = await iterator.next();
                if (!this.deps.generationGuard.isCurrent(options.gen)) {
                    await iterator.return?.();
                    closed = true;
                    return acc;
                }
                if (next.done) {
                    this.deps.generationGuard.runIfCurrent(options.gen, projection.commit);
                    closed = true;
                    return acc;
                }
                this.deps.generationGuard.runIfCurrent(options.gen, projection.commit);
                const filtered = this.deps.toolTracker.dedupeToolStarted(next.value);
                if (filtered) {
                    // An admitted tool_started is a new execution. If the provider reused the id of an earlier,
                    // settled call, that call's command messages must not hide this execution's result, and
                    // that call's rejection must not mark it.
                    if (filtered.type === 'tool_started') {
                        for (const id of this.deps.toolTracker.takeCommandMessageIdsOfEarlierExecution(filtered.toolCallId)) {
                            acc.emittedCommandIds.delete(id);
                        }
                        this.#toolCallMarkers.forgetApprovalRejection(filtered.toolCallId);
                    }
                    if (filtered.type === 'command_message')
                        this.deps.toolTracker.noteCommandMessageEmitted(filtered.message);
                    yield filtered;
                }
            }
        }
        finally {
            if (!closed) {
                await iterator.return?.();
            }
        }
    }
}
//# sourceMappingURL=session-stream-processor.js.map